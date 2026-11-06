// Splits markdown into top-level blocks with their source offsets, so the preview can edit one block at a time.
// Block edges sit on line boundaries and never include the newline after the last line, so replacing a block's
// [start, end) keeps the blank lines that separate it from its neighbours.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const RULE = /^ {0,3}([-*_])( *\1){2,} *$/;
const LIST = /^ {0,3}([-*+]|\d{1,9}[.)])(\s|$)/;
const INDENTED = /^( {2,}|\t)/;
const REF = /^ {0,3}\[[^\]]+\]:\s*\S/;

const blank = (l) => l.t.trim() === "";
// A list goes on while its items keep the same bullet, or the same `.` / `)` after their numbers; another one starts a new list.
const listType = (t) => { const m = t.match(LIST); return m ? (/\d/.test(m[1]) ? m[1].slice(-1) : m[1]) : null; };
const sameList = (type, t) => INDENTED.test(t) || !LIST.test(t) || listType(t) === type;

function lines(text) {
  const out = [];
  for (let pos = 0; ;) {
    let nl = text.indexOf("\n", pos);
    if (nl < 0) nl = text.length;
    out.push({ s: pos, e: nl, t: text.slice(pos, nl).replace(/\r$/, "") });
    if (nl >= text.length) return out;
    pos = nl + 1;
  }
}

function fenceEnd(ls, i) {
  const open = ls[i].t.match(FENCE)[1];
  for (let k = i + 1; k < ls.length; k++) {
    const m = ls[k].t.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
    if (m && m[1][0] === open[0] && m[1].length >= open.length) return k;
  }
  return ls.length - 1;
}

export function splitBlocks(text) {
  const ls = lines(text), out = [];
  const push = (i, j, kind) => out.push({ start: ls[i].s, end: ls[j].e, kind, src: text.slice(ls[i].s, ls[j].e) });
  let i = 0;
  if (ls[0].t === "---") {
    const k = ls.findIndex((l, n) => n > 0 && (l.t === "---" || l.t === "..."));
    if (k > 0) { push(0, k, "front"); i = k + 1; }
  }
  while (i < ls.length) {
    if (blank(ls[i])) { i++; continue; }
    const t = ls[i].t;
    if (FENCE.test(t)) { const j = fenceEnd(ls, i); push(i, j, "code"); i = j + 1; continue; }
    if (HEADING.test(t)) { push(i, i, "heading"); i++; continue; }
    if (RULE.test(t)) { push(i, i, "rule"); i++; continue; }
    const list = LIST.test(t), type = listType(t);
    let j = i;
    for (;;) {
      const n = j + 1;
      if (n >= ls.length) break;
      const l = ls[n];
      if (!blank(l)) {
        // Inside a list, indented fences and headings belong to an item; only one at the margin starts a new block.
        const top = !list || !INDENTED.test(l.t);
        // `---` under text is a setext heading underline, so only `***` and `___` cut a paragraph short.
        if (top && (FENCE.test(l.t) || HEADING.test(l.t) || (RULE.test(l.t) && !/^ {0,3}-/.test(l.t)))) break;
        if (list && FENCE.test(l.t) && INDENTED.test(l.t)) { j = fenceEnd(ls, n); continue; }
        if (list && !sameList(type, l.t)) break;
        j = n;
        continue;
      }
      // A loose list keeps going past blank lines while the next text is another item or an item's continuation.
      if (!list) break;
      let k = n;
      while (k < ls.length && blank(ls[k])) k++;
      if (k >= ls.length || !(LIST.test(ls[k].t) || INDENTED.test(ls[k].t)) || !sameList(type, ls[k].t)) break;
      j = k;
    }
    push(i, j, list ? "list" : "paragraph");
    if (list) out[out.length - 1].items = listItems(ls.slice(i, j + 1), text);
    i = j + 1;
  }
  return out;
}

// A list is edited one item at a time. An item runs from its marker line to the next marker at any depth, so a
// nested item is an item of its own; `depth` says how far in it sits. Marker-like lines inside an item's fenced code
// stay part of it.
function listItems(ls, text) {
  const items = [], stack = [];
  let cur = null, fence = null;
  const close = (k) => {
    let j = k;
    while (j > cur.i && blank(ls[j])) j--;
    items.push({ start: ls[cur.i].s, end: ls[j].e, kind: "item", depth: cur.depth, indent: cur.indent, src: text.slice(ls[cur.i].s, ls[j].e) });
  };
  ls.forEach((l, k) => {
    if (fence) { if (new RegExp("^\\s*" + fence[0] + "{" + fence.length + ",}\\s*$").test(l.t)) fence = null; return; }
    const m = l.t.match(/^([ \t]*)([-*+]|\d{1,9}[.)])(?:[ \t]+|$)/);
    if (!m || RULE.test(l.t)) {
      const f = l.t.match(/^\s*(`{3,}|~{3,})/);
      if (f) fence = f[1];
      return;
    }
    const indent = m[1].replace(/\t/g, "    ").length;
    if (cur) close(k - 1);
    while (stack.length && indent < stack[stack.length - 1]) stack.pop();
    cur = { i: k, depth: stack.length, indent };
    stack.push(indent + m[0].length - m[1].length);
  });
  if (cur) close(ls.length - 1);
  return items;
}

// What an item looks like on its own: its lines moved back to the margin, and an ordered marker given the number it
// shows inside the whole list, since a file may number every item `1.`.
export function itemMarkdown(item, number) {
  const strip = new RegExp("^[ \\t]{0," + item.indent + "}");
  let md = item.src.split("\n").map((l) => l.replace(strip, "")).join("\n");
  if (number != null) md = md.replace(/^\d{1,9}(?=[.)])/, String(number));
  return md;
}

// The number each ordered item shows: a list counts on from its first item, and each depth counts on its own.
export function itemNumbers(items) {
  const counters = [];
  return items.map((it) => {
    counters.length = it.depth + 1;
    const m = it.src.match(/^[ \t]*(\d{1,9})[.)]/);
    if (!m) { counters[it.depth] = undefined; return null; }
    counters[it.depth] = counters[it.depth] === undefined ? Number(m[1]) : counters[it.depth] + 1;
    return counters[it.depth];
  });
}

// Reference-style link definitions live in their own block but resolve links everywhere, so each rendered block needs them.
export function refDefs(blocks) {
  return blocks.filter((b) => b.kind === "paragraph" && b.src.split("\n").every((l) => REF.test(l) || l.trim() === "")).map((b) => b.src).join("\n");
}

// What replacing one block's source turns the document into, and how far text after the block moved.
export function replaceBlock(text, start, end, next) {
  if (next.trim() === "") {
    // An emptied block goes with its own line break. The blank lines around it are kept only as far as they still
    // separate something: a list item's neighbour must not end up glued to the paragraph after the list.
    let e = end;
    if (text[e] === "\r") e++;
    if (text[e] === "\n") e++;
    let before = text.slice(0, start), after = text.slice(e);
    if (after === "") before = before.replace(/(\r?\n)+$/, "\n").replace(/^\n$/, "");
    else if (before === "" || /\n\r?\n$/.test(before)) after = after.replace(/^(\r?\n)+/, "");
    const out = before + after;
    return { text: out, at: end, delta: out.length - text.length };
  }
  return { text: text.slice(0, start) + next + text.slice(end), at: end, delta: next.length - (end - start) };
}

// Appending a block after the last one, separated by one blank line; answers where the new block starts.
export function appendBlock(text, next) {
  const body = next.replace(/\n+$/, "");
  const sep = text === "" ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return { text: text + sep + body + "\n", start: text.length + sep.length, end: text.length + sep.length + body.length };
}
