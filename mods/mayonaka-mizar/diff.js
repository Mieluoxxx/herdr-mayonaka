// Unified diff parser for Mizar tool-result.meta.diff rendering in GPUI.

const MAX_DIFF_LINES_DEFAULT = 240;

export function parseUnifiedDiff(diffText, maxLines = MAX_DIFF_LINES_DEFAULT) {
  const raw = String(diffText ?? "");
  if (!raw.trim()) return { lines: [], truncated: 0 };

  const rawLines = raw.split("\n");
  const parsed = [];
  let oldNum = 0;
  let newNum = 0;
  let truncated = 0;

  for (const line of rawLines) {
    if (parsed.length >= maxLines) {
      truncated = rawLines.length - parsed.length;
      break;
    }

    if (
      line.startsWith("diff --git ")
      || line.startsWith("index ")
      || line.startsWith("--- ")
      || line.startsWith("+++ ")
      || line.startsWith("===")
    ) {
      parsed.push({ kind: "meta", text: line, oldLine: null, newLine: null });
      continue;
    }

    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldNum = Number(hunk[1]);
      newNum = Number(hunk[2]);
      parsed.push({ kind: "hunk", text: line, oldLine: null, newLine: null });
      continue;
    }

    if (line.startsWith("+")) {
      parsed.push({ kind: "add", text: line, oldLine: null, newLine: newNum++ });
    } else if (line.startsWith("-")) {
      parsed.push({ kind: "del", text: line, oldLine: oldNum++, newLine: null });
    } else if (line.startsWith("\\")) {
      parsed.push({ kind: "meta", text: line, oldLine: null, newLine: null });
    } else {
      parsed.push({
        kind: "ctx",
        text: line,
        oldLine: oldNum > 0 ? oldNum++ : null,
        newLine: newNum > 0 ? newNum++ : null,
      });
    }
  }

  return { lines: parsed, truncated };
}
