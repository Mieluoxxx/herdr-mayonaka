// Pure ESM port of Mizar's pi-emphasis pill grammar (mizar-tui-ui/src/emphasis.rs).
// Splits assistant markdown into native Markdown blocks and inline pill lines while
// leaving fenced code blocks and inline code spans untouched.

const ERROR_CORE = ["Failed", "Blocked", "Broken", "Unsafe"];
const ERROR_ALSO = ["fail", "failing", "error", "rejected", "down"];

const WARNING_CORE = [
  "Needs you", "Decision", "Unverified", "Partial", "Skipped", "In progress", "Pending", "At risk",
];
const WARNING_ALSO = ["needs review", "waiting", "review", "todo", "stale", "draft"];

const SUCCESS_CORE = ["Done", "Passed", "Observed", "Fixed", "Live", "Recommended", "Keep"];
const SUCCESS_ALSO = [
  "pass", "ready", "merged", "safe", "verified", "shipped", "ok", "approved",
  "complete", "completed", "finished", "healthy",
];

const DANGER_CORE = ["Costs money", "Destructive", "Irreversible"];
const MODE_CORE = ["Brainstorm", "Investigate", "Preview", "Implement", "Qualify"];
const OWNER_CORE = ["Owned", "Shared", "Foreign"];

const SYNONYMS = new Map([
  ["complete", "Done"],
  ["completed", "Done"],
  ["ok", "Done"],
  ["finished", "Done"],
  ["pass", "Passed"],
  ["fail", "Failed"],
  ["failing", "Failed"],
  ["error", "Failed"],
  ["waiting", "Pending"],
  ["needs review", "Review"],
]);

const KNOWN_WORDS_SORTED = [
  ...new Set([
    ...ERROR_CORE,
    ...ERROR_ALSO,
    ...WARNING_CORE,
    ...WARNING_ALSO,
    ...SUCCESS_CORE,
    ...SUCCESS_ALSO,
    ...DANGER_CORE,
    ...MODE_CORE,
    ...OWNER_CORE,
    ...SYNONYMS.keys(),
  ]),
].sort((a, b) => b.length - a.length);

function matchesWordSet(list, keyLower) {
  return list.some((w) => w.toLowerCase() === keyLower);
}

export function toneOfKey(key) {
  const k = String(key ?? "").toLowerCase();
  if (matchesWordSet(DANGER_CORE, k)) return "danger";
  if (matchesWordSet(ERROR_CORE, k) || matchesWordSet(ERROR_ALSO, k)) return "error";
  if (matchesWordSet(WARNING_CORE, k) || matchesWordSet(WARNING_ALSO, k)) return "warning";
  if (matchesWordSet(SUCCESS_CORE, k) || matchesWordSet(SUCCESS_ALSO, k)) return "success";
  if (matchesWordSet(MODE_CORE, k)) return "mode";
  if (matchesWordSet(OWNER_CORE, k)) return "owner";
  return "neutral";
}

function stripLeadingPuaGlyph(raw) {
  const trimmed = raw.trimStart();
  if (!trimmed) return "";
  const cp = trimmed.codePointAt(0);
  if ((cp >= 0xe000 && cp <= 0xf8ff) || (cp >= 0xf0000 && cp <= 0xffffd)) {
    const step = cp > 0xffff ? 2 : 1;
    return trimmed.slice(step).trimStart();
  }
  return trimmed;
}

function collapseSpaces(str) {
  return str.trim().replace(/\s+/g, " ");
}

export function parsePill(rawLabel) {
  const body = collapseSpaces(stripLeadingPuaGlyph(String(rawLabel ?? "")));
  const lower = body.toLowerCase();
  const known = KNOWN_WORDS_SORTED.find((w) => {
    const wl = w.toLowerCase();
    return lower === wl || (lower.startsWith(wl) && (lower[wl.length] === " " || lower[wl.length] === ":"));
  });

  const knownLower = known?.toLowerCase();
  const canonical = knownLower ? (SYNONYMS.get(knownLower) ?? null) : null;
  const key = (canonical ?? known ?? lower).toLowerCase();
  const word = canonical && known && body.length >= known.length
    ? `${canonical}${body.slice(known.length)}`
    : body;

  return {
    word: word || String(rawLabel ?? "").trim(),
    key,
    tone: toneOfKey(key),
  };
}

// Finds [[label]] occurrences in a single line outside inline `code` spans.
export function parseLinePillSegments(line) {
  const segments = [];
  let i = 0;
  let textStart = 0;
  let inlineTicks = 0;
  let foundPill = false;

  while (i < line.length) {
    if (line[i] === "`") {
      let count = 0;
      while (line[i + count] === "`") count++;
      if (inlineTicks === 0) inlineTicks = count;
      else if (inlineTicks === count) inlineTicks = 0;
      i += count;
      continue;
    }

    if (inlineTicks === 0 && line[i] === "[" && line[i + 1] === "[") {
      const close = line.indexOf("]]", i + 2);
      if (close > i + 2 && !line.slice(i + 2, close).includes("\n")) {
        const inner = line.slice(i + 2, close).trim();
        if (inner.length > 0 && inner.length <= 48) {
          if (i > textStart) {
            segments.push({ type: "text", text: line.slice(textStart, i) });
          }
          segments.push({ type: "pill", ...parsePill(inner) });
          foundPill = true;
          i = close + 2;
          textStart = i;
          continue;
        }
      }
    }
    i += 1;
  }

  if (!foundPill) return null;
  if (textStart < line.length) {
    segments.push({ type: "text", text: line.slice(textStart) });
  }
  return segments;
}

// Splits markdown text into alternating native markdown chunks and inline pill lines.
export function splitMarkdownWithPills(markdown) {
  const source = String(markdown ?? "");
  if (!source.includes("[[")) {
    return source ? [{ type: "markdown", text: source }] : [];
  }

  const lines = source.split("\n");
  const blocks = [];
  let mdLines = [];
  let activeFence = null;

  const flushMd = () => {
    if (mdLines.length === 0) return;
    blocks.push({ type: "markdown", text: mdLines.join("\n") });
    mdLines = [];
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (!activeFence) activeFence = marker[0].repeat(marker.length);
      else if (trimmed.startsWith(activeFence)) activeFence = null;
      mdLines.push(line);
      continue;
    }

    if (!activeFence) {
      const segs = parseLinePillSegments(line);
      if (segs) {
        flushMd();
        blocks.push({ type: "pill-line", segments: segs });
        continue;
      }
    }
    mdLines.push(line);
  }
  flushMd();
  return blocks;
}
