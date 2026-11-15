// Reading and saving past herdr's own limits. readTextFile and writeTextFile stop at 1 MiB, and writeTextFile only writes on
// this computer. Larger files (up to 8 MiB, exec's output cap) are read with fs under home or cat through sh elsewhere, and
// saved—like every remote save—by staging the text here and piping it into `hc file write`, after checking that the file
// still matches what the pane opened. `hc file write` keeps the file's mode, follows a symlink and replaces atomically.
import { exec, readTextFile, writeTextFile, appHome } from "herdr";
import { readFile, writeFile, mkdir, unlink } from "fs/promises";
import { createHash } from "crypto";
import { Buffer } from "buffer";

export const MAX = 8 * 1024 * 1024;
const BUILTIN_MAX = 1024 * 1024;
const STAGE = "cache/mayonaka-editor/save";
let saveSeq = 0;

export class BinaryFileError extends Error {
  constructor() { super("Binary file · not editable"); }
}

export class TooLargeError extends Error {
  constructor() { super("Cannot open this file (too large, over 8 MiB, or unreadable)"); }
}

export function digestOf(bytes) {
  return { bytes: bytes.length, sha1: createHash("sha1").update(bytes).digest("hex") };
}

export function textDigest(text) {
  return digestOf(Buffer.from(text, "utf8"));
}

function sameDigest(a, b) {
  return Boolean(a && b && a.bytes === b.bytes && a.sha1 === b.sha1);
}

// hc reports a failure as {"error": {"message"}} with a nonzero exit; sh itself says "not found" on stderr.
function reason(r) {
  for (const out of [r.stdout, r.stderr]) {
    try { const message = JSON.parse(out)?.error?.message; if (message) return message; } catch { /* not JSON */ }
  }
  return r.stderr.trim() || r.stdout.trim() || `hc exited with ${r.code}`;
}

// Buffer.toString("utf8") replaces bad bytes with U+FFFD, so only a string containing U+FFFD can have come from non-UTF-8
// input, and re-encoding matches the source byte-for-byte iff every U+FFFD was genuinely in the file.
function decodeUtf8(bytes) {
  if (bytes.includes(0)) throw new BinaryFileError();
  const text = Buffer.from(bytes).toString("utf8");
  if (text.includes("\uFFFD")) {
    const rt = Buffer.from(text, "utf8");
    if (rt.length !== bytes.length) throw new BinaryFileError();
    for (let i = 0; i < bytes.length; i++) if (rt[i] !== bytes[i]) throw new BinaryFileError();
  }
  return text;
}

async function fileSha1ViaExec(file, on) {
  const sum = await exec("sh", ["-c", '(sha1sum < "$1" || shasum < "$1" || openssl sha1 < "$1" | sed "s/^.*= //") 2>/dev/null', "sh", file], { on });
  return sum.code === 0 ? sum.stdout.trim().split(/\s+/)[0].toLowerCase() : "";
}

async function verifyRemoteUtf8(file, text, on) {
  const want = createHash("sha1").update(Buffer.from(text, "utf8")).digest("hex");
  const got = await fileSha1ViaExec(file, on);
  if (got !== want) throw new BinaryFileError();
}

async function readViaExec(file, on) {
  const script = `[ -e "$1" ] || exit 44; [ -f "$1" ] || exit 45; n=$(wc -c < "$1") || exit 1; [ "$((n))" -le ${MAX} ] || exit 46; exec cat < "$1"`;
  const r = await exec("sh", ["-c", script, "sh", file], { on, timeout: 60000 });
  if (r.code === 44) return null;
  if (r.code === 46 || r.stderr.includes("[hc] output cut")) throw new TooLargeError();
  if (r.code !== 0) throw new Error(r.stderr.trim() || `sh exited with ${r.code}`);
  if (r.stdout.includes("\0")) throw new BinaryFileError();
  if (r.stdout.includes("\uFFFD")) await verifyRemoteUtf8(file, r.stdout, on);
  return r.stdout;
}

async function readLocalLarge(file, known = null) {
  const check = await exec("sh", ["-c", '[ -e "$1" ] || exit 44; [ -f "$1" ] || exit 45; wc -c < "$1"', "sh", file]);
  if (check.code === 44) return { status: "missing" };
  if (check.code !== 0) throw new Error(check.stderr.trim() || `sh exited with ${check.code}`);
  const size = Number(check.stdout.trim());
  if (!Number.isFinite(size)) throw new Error("unreadable file size");
  if (size > MAX) throw new TooLargeError();
  let bytes;
  try { bytes = await readFile(file); }
  catch {
    if (known && size === known.bytes) {
      const got = await fileSha1ViaExec(file, null);
      if (got && got === known.sha1) return { status: "unchanged" };
    }
    const text = await readViaExec(file, null);
    return text === null ? { status: "missing" } : { status: "ok", text, digest: textDigest(text) };
  }
  if (bytes.length > MAX) throw new TooLargeError();
  const digest = digestOf(bytes);
  if (sameDigest(digest, known)) return { status: "unchanged" };
  return { status: "ok", text: decodeUtf8(bytes), digest };
}

// When `known` ({bytes, sha1}) is given for a local file, a matching disk snapshot returns {status: "unchanged"} right
// after the <= 8 MiB size gate and sha1 check, without allocating a JS string for the file's UTF-8 text.
export async function readEditorFile(file, on = null, known = null) {
  if (!on && known && known.bytes > BUILTIN_MAX) return readLocalLarge(file, known);
  try {
    const text = await readTextFile(file, { on });
    if (text === null) return { status: "missing" };
    if (text.includes("\0")) throw new BinaryFileError();
    if (on && text.includes("\uFFFD")) await verifyRemoteUtf8(file, text, on);
    const digest = textDigest(text);
    if (sameDigest(digest, known)) return { status: "unchanged" };
    return { status: "ok", text, digest };
  } catch (e) {
    if (e instanceof BinaryFileError) throw e;
    const msg = String(e?.message ?? e);
    if (/utf-?8/i.test(msg)) throw new BinaryFileError();
    if (!/exceeds 1 MiB/i.test(msg)) throw e;
  }
  if (on) {
    const text = await readViaExec(file, on);
    return text === null ? { status: "missing" } : { status: "ok", text, digest: textDigest(text) };
  }
  return readLocalLarge(file, known);
}

export async function readEditorText(file, on = null) {
  const r = await readEditorFile(file, on, null);
  return r.status === "missing" ? null : r.text;
}

// `expected` is what the file held when it was opened (or last saved). Small local saves use writeTextFile directly; remote
// saves and files over 1 MiB check the disk snapshot first, refuse when it differs, and pipe staged bytes into `hc file write`.
export async function writeEditorText(file, text, expected, on = null, id = null, expectedDigest = null) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > MAX) throw new Error("exceeds 8 MiB");
  const nextDigest = digestOf(bytes);
  const expBytes = expected === null ? 0 : (expectedDigest?.bytes ?? Buffer.from(expected, "utf8").length);
  if (!on && bytes.length <= BUILTIN_MAX && expBytes <= BUILTIN_MAX) {
    try {
      await writeTextFile(file, text, expected);
      return nextDigest;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (!/exceeds 1 MiB/i.test(msg)) {
        if (/changed outside|changed while saving|stale/i.test(msg)) throw new Error("changed on disk since it was opened");
        throw e;
      }
    }
  }
  const where = on ? `on ${on}` : "on disk";
  const known = !on && expected !== null ? (expectedDigest ?? textDigest(expected)) : null;
  let cur;
  try {
    cur = await readEditorFile(file, on, known);
  } catch (e) {
    if (e instanceof BinaryFileError || e instanceof TooLargeError) throw new Error(`changed ${where} since it was opened`);
    throw e;
  }
  if (expected === null) {
    if (cur.status !== "missing") throw new Error(`changed ${where} since it was opened`);
  } else if (cur.status === "missing") {
    throw new Error(`no longer exists ${where}`);
  } else if (cur.status !== "unchanged" && cur.text !== expected) {
    throw new Error(`changed ${where} since it was opened`);
  }
  const safeId = String(id ?? "pane").replace(/[^a-zA-Z0-9_-]/g, "_");
  const dir = `${appHome()}/${STAGE}`, staged = `${dir}/${safeId}-${++saveSeq}.txt`;
  await mkdir(dir, { recursive: true });
  await writeFile(staged, bytes);
  try {
    const r = on
      ? await exec("sh", ["-c", 'exec hc file write --on "$1" "$2" < "$3"', "sh", on, file, staged], { timeout: 60000 })
      : await exec("sh", ["-c", 'exec hc file write "$1" < "$2"', "sh", file, staged], { timeout: 60000 });
    if (r.code !== 0) throw new Error(reason(r));
    let wrote = null;
    try { wrote = JSON.parse(r.stdout).bytes; } catch { /* checked below */ }
    if (wrote !== bytes.length) throw new Error(wrote === null ? "hc did not say how much it wrote" : `${wrote} of ${bytes.length} bytes were written`);
    return nextDigest;
  } finally {
    await unlink(staged).catch(() => {});
  }
}

export const writeRemoteText = writeEditorText;
