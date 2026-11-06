// What the block being edited shows rendered instead of as markdown. A Textarea keeps the block's exact source and
// draws chosen spans of it as atomic tokens, so a token's text is always the markdown it stands for and the block's
// value is its markdown with nothing to translate back.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
// Quote bars, then a list marker with an optional task box, or a heading's hashes.
const MARKER = /^((?: {0,3}>[ \t]?)*)(?:([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)|( {0,3}#{1,6}(?:[ \t]+|$)))?/;
const INLINE = new RegExp([
  /(?<!\\)`[^`\n]+`/,
  /(?<!\\)!\[[^\]\n]*\]\([^)\n]*\)/,
  /(?<![\\!])\[[^\]\n]+\](?:\([^)\n]*\)|\[[^\]\n]*\])/,
  /(?<!\\)<https?:\/\/[^>\s]+>/,
  /(?<![\\*])\*\*(?=\S)[^*\n]*?\S\*\*(?!\*)/,
  /(?<![\\_\w])__(?=\S)[^_\n]*?\S__(?![_\w])/,
  /(?<!\\)~~(?=\S)[^~\n]*?\S~~/,
  /(?<![\\*\w])\*(?=[^\s*])[^*\n]*?[^\s*\\]\*(?![*\w])|(?<![\\*\w])\*[^\s*]\*(?![*\w])/,
  /(?<![\\_\w])_(?=[^\s_])[^_\n]*?[^\s_\\]_(?![_\w])|(?<![\\_\w])_[^\s_]_(?![_\w])/,
].map((r) => r.source).join("|"), "g");

export function kindOf(text) {
  if (text.startsWith("`")) return "code";
  if (text.startsWith("![")) return "image";
  if (text.startsWith("[")) return "link";
  if (text.startsWith("<")) return "autolink";
  if (text.startsWith("**") || text.startsWith("__")) return "bold";
  if (text.startsWith("~~")) return "strike";
  return "italic";
}

// Blocks whose look a Textarea cannot draw — code, tables, front matter, indented code — are edited as plain source.
export function blockMode(text) {
  const first = text.split("\n", 1)[0];
  if (FENCE.test(first)) return "code";
  if (first === "---" || /^( {4}|\t)/.test(first)) return "raw";
  if (text.split("\n").some((l) => /^[\s|:-]+$/.test(l) && l.includes("|") && /-{3,}/.test(l))) return "raw";
  return "rich";
}

function lineMarker(line) {
  const m = line.match(MARKER);
  return m && m[0] ? m[0] : "";
}

export function tokenize(text, mode = blockMode(text)) {
  const out = [];
  const lines = text.split("\n");
  let pos = 0;
  lines.forEach((line, i) => {
    if (mode === "code") {
      if ((i === 0 || i === lines.length - 1) && FENCE.test(line) && line.length)
        out.push({ range: { start: pos, end: pos + line.length }, token: { id: "fence", text: line } });
    } else if (mode === "rich") {
      const marker = lineMarker(line);
      if (marker) out.push({ range: { start: pos, end: pos + marker.length }, token: { id: "marker", text: marker } });
      const rest = line.slice(marker.length);
      INLINE.lastIndex = 0;
      for (let m; (m = INLINE.exec(rest));) {
        const start = pos + marker.length + m.index;
        out.push({ range: { start, end: start + m[0].length }, token: { id: kindOf(m[0]), text: m[0] } });
      }
    }
    pos += line.length + 1;
  });
  return out;
}

// What one edit did, from the text before and after it: the span [start, before) became [start, after).
export function diff(prev, next) {
  let a = 0;
  while (a < prev.length && a < next.length && prev[a] === next[a]) a++;
  let b = 0;
  while (b < prev.length - a && b < next.length - a && prev[prev.length - 1 - b] === next[next.length - 1 - b]) b++;
  return { start: a, before: prev.length - b, after: next.length - b };
}

export function parseMarker(text) {
  const m = text.match(MARKER) ?? [];
  const quote = m[1] ?? "", list = m[2] ?? "", heading = m[3] ?? "";
  const task = list.match(/\[([ xX])\]/);
  const bullet = list.match(/^([ \t]*)([-*+]|\d{1,9}[.)])/);
  return {
    quotes: (quote.match(/>/g) ?? []).length,
    indent: bullet ? bullet[1].replace(/\t/g, "    ").length : 0,
    bullet: bullet ? bullet[2] : null,
    task: task ? task[1] !== " " : null,
    heading: heading ? heading.trim().length : 0,
  };
}

// What Return on `line` should start the next line with: the same quote bars, the next bullet or number, an empty task
// box. `exit` when the line held nothing but its marker, which is how a list or quote is left.
export function continueLine(line) {
  const marker = lineMarker(line);
  if (!marker) return null;
  const m = marker.match(MARKER);
  if (m[3]) return null;
  if (line.slice(marker.length).trim() === "") return { exit: true, marker };
  let list = m[2] ?? "";
  list = list.replace(/^([ \t]*)(\d{1,9})([.)])/, (_, ind, n, d) => ind + (Number(n) + 1) + d).replace(/\[[xX]\]/, "[ ]");
  return { exit: false, marker, next: (m[1] ?? "") + list };
}

export function toggleTask(marker) {
  return marker.replace(/\[([ xX])\]/, (_, c) => (c === " " ? "[x]" : "[ ]"));
}
