// A save on another machine. herdr's writeTextFile only writes on this computer and exec has no stdin, so the text waits
// in a file here and `hc file write --on` reads it from there. That call keeps the file's mode, follows a symlink and
// answers with the bytes it wrote.
import { exec, readTextFile, appHome } from "herdr";
import { writeFile, mkdir, unlink } from "fs/promises";
import { Buffer } from "buffer";

const STAGE = "cache/mayonaka-editor/save";

// hc reports a failure as {"error": {"message"}} with a nonzero exit; sh itself says "not found" on stderr.
function reason(r) {
  for (const out of [r.stdout, r.stderr]) {
    try { const message = JSON.parse(out)?.error?.message; if (message) return message; } catch { /* not JSON */ }
  }
  return r.stderr.trim() || r.stdout.trim() || `hc exited with ${r.code}`;
}

// `expected` is what the file held when it was opened. hc has no compare-and-swap, so the file is read back just before the
// write and the save refused when it differs, as writeTextFile does here. Rejects with a reason a person can read.
export async function writeRemoteText(file, text, expected, on, id) {
  const now = await readTextFile(file, { on });
  if (now === null) throw new Error(`no longer exists on ${on}`);
  if (now !== expected) throw new Error(`changed on ${on} since it was opened`);
  const bytes = Buffer.from(text, "utf8"), dir = `${appHome()}/${STAGE}`, staged = `${dir}/${id ?? "pane"}.txt`;
  await mkdir(dir, { recursive: true });
  await writeFile(staged, bytes);
  try {
    const r = await exec("sh", ["-c", 'exec hc file write --on "$1" "$2" < "$3"', "sh", on, file, staged], { timeout: 60000 });
    if (r.code !== 0) throw new Error(reason(r));
    let wrote = null;
    try { wrote = JSON.parse(r.stdout).bytes; } catch { /* checked below */ }
    if (wrote !== bytes.length) throw new Error(wrote === null ? "hc did not say how much it wrote" : `${wrote} of ${bytes.length} bytes were written`);
  } finally {
    await unlink(staged).catch(() => {});
  }
}
