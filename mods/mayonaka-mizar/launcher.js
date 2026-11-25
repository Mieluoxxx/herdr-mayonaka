// Managed `mizar rpc` process launcher, ready-file waiter, workspace file indexer,
// and Mizar composer command/completion parser (`/`, `@`, `!`, `!!`).
import { parseTcpAddr } from "./rpc.js";

const DEFAULT_MAX_WORKSPACE_FILES = 5000;

export function posixQuote(arg) {
  return "'" + String(arg ?? "").replace(/'/g, "'\\''") + "'";
}

export function buildLaunchCommand({
  bin = "mizar",
  workspace,
  readyFile,
  resumeSessionId = null,
  continueLatest = false,
  parentPid = null,
  idleExitSecs = 45,
  approve = false,
}) {
  if (!workspace || !readyFile) {
    throw new Error("buildLaunchCommand requires workspace and readyFile");
  }
  const parts = [posixQuote(bin), "rpc", "--workspace", posixQuote(workspace)];
  if (resumeSessionId) {
    parts.push("--resume", posixQuote(resumeSessionId));
  } else if (continueLatest) {
    parts.push("--continue");
  }
  if (approve) parts.push("--approve");
  if (parentPid != null && Number(parentPid) > 0) {
    parts.push("--parent-pid", String(Math.floor(Number(parentPid))));
  }
  parts.push("--ready-file", posixQuote(readyFile));
  parts.push("--idle-exit-secs", String(Math.max(0, Math.floor(Number(idleExitSecs ?? 0)))));
  return `${parts.join(" ")} </dev/null >/dev/null 2>&1 & echo $!`;
}

export async function waitForReadyFile(
  readyFile,
  { readFile, unlink = null, sleep, timeoutMs = 10000, pollMs = 50 },
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    let raw = null;
    try {
      raw = await readFile(readyFile, "utf8");
    } catch {
      raw = null;
    }
    if (raw) {
      try {
        const meta = JSON.parse(raw);
        const tcp = parseTcpAddr(meta?.tcp_addr);
        if (meta && typeof meta.pid === "number" && meta.session_id && tcp && meta.rpc_token) {
          if (typeof unlink === "function") {
            try { await unlink(readyFile); } catch {}
          }
          return { ...meta, tcpHost: tcp.host, tcpPort: tcp.port };
        }
      } catch {
        // Atomic rename ensures valid JSON, but tolerate partial non-atomic test writes briefly.
      }
    }
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for Mizar RPC ready file: ${readyFile}`);
}

export function parseComposerCommand(rawText) {
  const raw = String(rawText ?? "");
  const trimmed = raw.trim();
  if (!trimmed) return { kind: "empty" };

  if (trimmed.startsWith("!!")) {
    return {
      kind: "bash",
      command: trimmed.slice(2).trim(),
      excludeFromContext: true,
    };
  }
  if (trimmed.startsWith("!")) {
    return {
      kind: "bash",
      command: trimmed.slice(1).trim(),
      excludeFromContext: false,
    };
  }
  if (trimmed.startsWith("/")) {
    const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
    if (match) {
      return {
        kind: "slash",
        command: match[1].toLowerCase(),
        arg: (match[2] ?? "").trim(),
      };
    }
  }
  return { kind: "prompt", text: raw };
}

export function detectActiveCompletion(text) {
  const s = String(text ?? "");
  const trimmedStart = s.trimStart();
  if (trimmedStart.startsWith("/") && !trimmedStart.includes("\n")) {
    const wsAfter = trimmedStart.search(/\s/);
    if (wsAfter === -1) {
      const leadLen = s.length - trimmedStart.length;
      return {
        kind: "slash",
        query: trimmedStart.slice(1).toLowerCase(),
        replaceStart: leadLen,
        replaceEnd: s.length,
      };
    }
  }

  const mentionMatch = /(^|[\s(])@([^\s@]*)$/.exec(s);
  if (mentionMatch) {
    const fullPrefixLen = mentionMatch[1].length;
    const atIndex = mentionMatch.index + fullPrefixLen;
    return {
      kind: "mention",
      query: mentionMatch[2],
      replaceStart: atIndex,
      replaceEnd: s.length,
    };
  }

  return null;
}

function fuzzyPathScore(path, queryLower) {
  if (!queryLower) return 1;
  const p = path.toLowerCase();
  const base = p.split("/").pop() ?? p;
  if (base === queryLower) return 500;
  if (base.startsWith(queryLower)) return 400 - p.length * 0.01;
  const idx = p.indexOf(queryLower);
  if (idx >= 0) return 300 - idx * 0.5 - p.length * 0.01;

  let qi = 0;
  let score = 0;
  let run = 0;
  for (let i = 0; i < p.length && qi < queryLower.length; i++) {
    if (p[i] === queryLower[qi]) {
      const boundary = i === 0 || p[i - 1] === "/" || p[i - 1] === "_" || p[i - 1] === "-";
      score += 2 + (boundary ? 5 : 0) + run * 2;
      run += 1;
      qi += 1;
    } else {
      run = 0;
    }
  }
  return qi === queryLower.length ? score - p.length * 0.01 : null;
}

export function filterFileCandidates(files, query, limit = 10) {
  const list = Array.isArray(files) ? files : [];
  const q = String(query ?? "").trim().toLowerCase();
  if (!q) return list.slice(0, limit);

  const scored = [];
  for (const file of list) {
    const score = fuzzyPathScore(file, q);
    if (score !== null) scored.push({ file, score });
  }
  scored.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  return scored.slice(0, limit).map((x) => x.file);
}

export async function resolveWorkspaceFiles(cwd, { exec, maxFiles = DEFAULT_MAX_WORKSPACE_FILES }) {
  if (!cwd || typeof exec !== "function") return [];
  const pushUnique = (items) => {
    const seen = new Set();
    const out = [];
    for (const item of items) {
      const clean = item.replace(/^\.\//, "").trim();
      if (!clean || seen.has(clean)) continue;
      seen.add(clean);
      out.push(clean);
      if (out.length >= maxFiles) break;
    }
    return out;
  };

  try {
    const gitRes = await exec(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd, timeout: 8000 },
    );
    if (gitRes?.code === 0 && gitRes.stdout) {
      return pushUnique(gitRes.stdout.split("\0"));
    }
  } catch {}

  try {
    const rgRes = await exec("rg", ["--files", "--hidden", "-g", "!.git"], { cwd, timeout: 8000 });
    if (rgRes?.code === 0 && rgRes.stdout) {
      return pushUnique(rgRes.stdout.split(/\r?\n/));
    }
  } catch {}

  try {
    const findRes = await exec("find", [".", "-maxdepth", "4", "-not", "-path", "*/.git/*"], { cwd, timeout: 8000 });
    if (findRes?.code === 0 && findRes.stdout) {
      return pushUnique(findRes.stdout.split(/\r?\n/));
    }
  } catch {}

  return [];
}
