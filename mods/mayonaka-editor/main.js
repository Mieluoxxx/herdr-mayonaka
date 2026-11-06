// A file editor pane, opened beside the terminals by mayonaka-files: pane.split {mod: "mayonaka-editor", props: {id, file, on, root}}.
// mayonaka-files retargets an open editor through shared("mayonaka-editor.open") instead of splitting again.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Textarea, TextareaState } from "gpui-base";
import { splitBlocks, refDefs, replaceBlock, appendBlock, itemMarkdown, itemNumbers } from "./blocks.js";
import { tokenize, blockMode, diff, continueLine, parseMarker, toggleTask } from "./inline.js";
import { props, shared, setShared, readTextFile, writeTextFile, watchFolder, exec, notify, nextCommand, theme, settings } from "herdr";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", svelte: "html", vue: "html", md: "markdown", markdown: "markdown", py: "python", rs: "rust", sh: "bash", zsh: "bash" };
const MAX = 1024 * 1024;
const HEADING = { 1: 30, 2: 23, 3: 19, 4: 17, 5: 15, 6: 14 };
const isMarkdown = (f) => /\.(md|markdown|mdx)$/i.test(f ?? "");
const dirname = (f) => f.slice(0, f.lastIndexOf("/")) || "/";

function resolve(base, rel) {
  const parts = (rel.startsWith("/") ? rel : `${dirname(base)}/${rel}`).split("/"), out = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(p); }
  return "/" + out.join("/");
}

export default class EditorPane extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.id = p.id ?? null;
    // Retargets live in shared state so a restart reopens the file shown last, not the one the pane was made with.
    const saved = this.id ? shared("mayonaka-editor.files")?.[this.id] : null;
    this.seen = shared("mayonaka-editor.open")?.n ?? 0;
    this.open(saved ?? { file: p.file, on: p.on ?? null, root: p.root ?? null }, cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "save") await this.save(cx);
        else if (c === "toggle" && isMarkdown(this.file)) { this.commit(); this.mode = this.mode === "preview" ? "source" : "preview"; }
        cx.notify();
      }
    });
  }

  open({ file, on = null, root = null }, cx) {
    if (!file) return;
    this.commit();
    if (this.dirty && !this.discardAsked) {
      notify({ title: "Unsaved changes", body: `${this.file.split("/").pop()} has unsaved edits. Save with ⌘S, or click the file again to discard.`, level: "warning" });
      this.discardAsked = file;
      return;
    }
    if (this.discardAsked && this.discardAsked !== file) { this.discardAsked = null; return; }
    this.discardAsked = null;
    this.state?.release(); this.state = null;
    Object.assign(this, { file, on, root, original: null, dirty: false, error: null, mode: isMarkdown(file) ? "preview" : "source" });
    if (this.id) setShared("mayonaka-editor.files", { ...(shared("mayonaka-editor.files") ?? {}), [this.id]: { file, on, root } });
    this.load(cx);
    this.watch(cx);
  }

  load(cx) {
    const file = this.file;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(file, { on: this.on });
        if (this.file !== file) return;
        if (text === null) this.error = "This file is no longer available";
        else if (text.includes("\0")) this.error = "Binary file · not editable";
        else if (this.state) { if (!this.dirty && !this.edit && text !== this.original) { this.original = text; this.state.set_value(text); } }
        else {
          this.original = text;
          const t = theme(), ext = file.includes(".") ? file.split(".").pop().toLowerCase() : "txt";
          this.state = EditorState.new({ language: LANG[ext] ?? ext, value: text, readonly: Boolean(this.on),
            font_family: settings().font_family, font_size: 13, soft_wrap: isMarkdown(file),
            syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi6 } });
          this.state.on("change", (_e, cx) => {
            const dirty = this.state.value() !== this.original;
            if (dirty !== this.dirty || this.mode === "preview") { this.dirty = dirty; cx.notify(); }
          });
        }
      } catch { if (this.file === file) this.error = "Cannot open this file (too large, over 1 MiB, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  watch(cx) {
    if (this.on) return;
    const file = this.file, dir = dirname(file);
    cx.spawn(async (cx) => {
      try {
        while (this.file === file) {
          const changed = await watchFolder(dir);
          if (this.file === file && (changed.includes(file) || changed.includes(dir))) this.load(cx);
        }
      } catch { /* the folder went away; the next open watches again */ }
    });
  }

  async save(cx) {
    this.commit(true);
    if (!this.state || this.on || !this.dirty) return;
    const text = this.state.value();
    try {
      await writeTextFile(this.file, text, this.original);
      this.original = text; this.dirty = false;
    } catch (e) {
      notify({ title: "Not saved", body: `${this.file.split("/").pop()} changed on disk since it was opened. ${e}`, level: "error" });
    }
    cx.notify();
  }

  link(url, cx) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) { exec("open", [url]); return; }
    const path = decodeURIComponent(url.split("#")[0]);
    if (path) this.open({ file: resolve(this.file, path), on: this.on, root: this.root }, cx);
  }

  crumbs(t) {
    const rel = this.root && this.file.startsWith(this.root + "/") ? this.file.slice(this.root.length + 1) : this.file.replace(/^\//, "");
    const parts = rel.split("/"), out = [];
    parts.forEach((p, i) => {
      if (i) out.push(div().flex_none().text_color(t.dim).child("›"));
      out.push(div().flex_none().when(i < parts.length - 1, (el) => el.text_color(t.muted)).child(p));
    });
    return out;
  }

  toggle(t, mode, icon) {
    const on = this.mode === mode;
    return div().id(`mode-${mode}`).p(4).rounded(5).cursor_pointer()
      .text_color(on ? t.foreground : t.dim).when(on, (el) => el.bg(t.selected)).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.commit(); this.mode = mode; cx.notify(); })
      .child(svg(`mods/mayonaka-editor/${icon}.svg`).size(14));
  }

  // The document stays in the EditorState; a block edit is a Textarea over one [start, end) slice of it, written back when a
  // press lands outside it, on Escape, or before a save, a mode switch or another file. Not on blur: the pane moves focus
  // around on its own, and a block that closed whenever that happened could not be typed into.
  blocks() {
    const text = this.state.value();
    if (this.parsed?.text !== text) {
      const list = splitBlocks(text);
      this.parsed = { text, list, refs: refDefs(list) };
    }
    return this.parsed;
  }

  edit_block(b, cx) {
    if (this.edit?.ta && this.edit.start === b.start && this.edit.src === b.src) return;
    const before = this.parsed;
    this.commit();
    let { start, end } = b;
    // Committing the previous block can move this one; a click is resolved against the text it was drawn from.
    if (this.moved && this.moved.from === before && start >= this.moved.at) { start += this.moved.delta; end += this.moved.delta; }
    if (b.append) start = end = this.state.value().length;
    else if (this.state.value().slice(start, end) !== b.src) { cx.notify(); return; }
    const ta = TextareaState.new({ value: b.src });
    ta.set_auto_grow(1, 1000);
    ta.set_value({ text: b.src, tokens: tokenize(b.src) });
    ta.on("change", (_e, cx) => { if (this.edit?.ta === ta) { this.restyle(this.edit); cx.notify(); } });
    this.edit = { ta, start, end, src: b.src, append: Boolean(b.append), prev: b.src, open: null, indent: b.indent ?? 0 };
    this.pending = false;
    // The pane takes focus for itself while handling the click that opened the block, so focus the block after it.
    cx.spawn(async (cx) => { await cx.sleep(0); if (this.edit?.ta === ta) ta.focus(); });
    cx.notify();
  }

  // Keeps the open block drawn as rendered markdown while it is typed into. Markers and inline marks become tokens as
  // soon as their markdown is complete, and stop being tokens when an edit breaks them. Everything here is a range edit
  // the Textarea applies itself: set_value lands a frame later and would overwrite whatever was typed in between.
  restyle(e) {
    const ta = e.ta, text = ta.value(), d = diff(e.prev, text), changed = text !== e.prev;
    if (changed && e.open) {
      const delta = (d.after - d.start) - (d.before - d.start);
      if (d.before <= e.open.start) e.open = { start: e.open.start + delta, end: e.open.end + delta };
      else if (d.start >= e.open.start && d.before <= e.open.end) e.open = { start: e.open.start, end: e.open.end + delta };
      else e.open = null;
    }
    const mode = blockMode(text);
    // Return after a list item or a quoted line starts the next one with its marker; on a line holding only a marker it ends the list.
    if (changed && mode === "rich" && d.before === d.start && d.after === d.start + 1 && text[d.start] === "\n") {
      // Return at the end of a line that has more lines after it reads the same as one at the start of the next line;
      // the earliest place in the run of newlines is the one that was typed.
      let at = d.start;
      while (at > 0 && text[at - 1] === "\n") at--;
      const ls = text.lastIndexOf("\n", at - 1) + 1, c = continueLine(text.slice(ls, at));
      if (c?.exit) {
        ta.set_selected_range({ start: ls, end: ls + c.marker.length });
        ta.replace("");
        ta.set_selected_range({ start: at + 1 - c.marker.length, end: at + 1 - c.marker.length });
      } else if (c) {
        ta.set_selected_range({ start: at + 1, end: at + 1 });
        ta.replace_with_token({ id: "marker", text: c.next });
      }
      e.prev = ta.value();
      this.pending = e.prev !== e.src;
      return;
    }
    const content = ta.content(), want = tokenize(content.text, mode);
    const key = (s) => `${s.range.start}:${s.range.end}:${s.token.text}`;
    const wanted = new Set(want.map(key)), have = new Set(content.tokens.map(key));
    const caret = changed ? d.after : null;
    let moved = false;
    if (changed) for (const s of content.tokens) if (!wanted.has(key(s))) {
      ta.set_selected_range(s.range);
      ta.replace(s.token.text);
      moved = true;
    }
    const overlaps = (a, b) => a.start < b.end && b.start < a.end;
    for (const s of want) {
      if (have.has(key(s))) continue;
      if (e.open && overlaps(s.range, e.open)) continue;
      // A mark the caret sits inside is still being typed.
      if (caret !== null && caret > s.range.start && caret < s.range.end) continue;
      if (content.tokens.some((h) => wanted.has(key(h)) && overlaps(h.range, s.range))) continue;
      ta.replace_range_with_token(s.range, s.token);
    }
    if (moved && caret !== null) ta.set_selected_range({ start: caret, end: caret });
    e.prev = ta.value();
    this.pending = e.prev !== e.src;
  }

  // A click on a mark shows its markdown for editing; a click on a task box ticks it.
  token_click(ev, cx) {
    const e = this.edit;
    if (!e) return;
    if (ev.token.id === "marker" && parseMarker(ev.token.text).task !== null) {
      e.ta.set_selected_range(ev.range);
      e.ta.replace_with_token({ id: "marker", text: toggleTask(ev.token.text) });
    } else {
      e.ta.set_selected_range(ev.range);
      e.ta.replace(ev.token.text);
      e.open = { ...ev.range };
    }
    cx.notify();
  }

  // How the open block's tokens draw, matching the rendered preview around them.
  token_view(ctx, t) {
    const s = ctx.token.text;
    switch (ctx.token.id) {
      case "marker": {
        const m = parseMarker(s), parts = [];
        for (let q = 0; q < m.quotes; q++) parts.push(div().w(3).h(ctx.line_height).rounded(2).bg(t.border));
        if (m.heading) parts.push(div().text_size(10).text_color(t.dim).child("H" + m.heading));
        // The open item is already drawn at its depth, so only indentation beyond its first line's shows.
        if (m.bullet) parts.push(div().pl(Math.max(0, m.indent - (this.edit?.indent ?? 0)) * 7).text_color(t.dim).child(/\d/.test(m.bullet) ? m.bullet : "•"));
        if (m.task !== null) parts.push(div().cursor_pointer().text_color(m.task ? t.accent : t.dim).child(m.task ? "☑" : "☐"));
        return h_flex().items_center().gap(6).pr(6).children(parts);
      }
      case "bold": return div().font_bold().child(s.slice(2, -2));
      case "italic": return div().italic().child(s.slice(1, -1));
      case "strike": return div().line_through().child(s.slice(2, -2));
      case "code": return div().px(4).rounded(4).bg(t.selected).font_family(settings().font_family).child(s.slice(1, -1));
      case "link": return div().text_color(t.accent).underline().child(s.slice(1, s.indexOf("]")));
      case "autolink": return div().text_color(t.accent).underline().child(s.slice(1, -1));
      case "image": return div().px(4).rounded(4).bg(t.selected).text_color(t.dim).child("▣ " + (s.slice(2, s.indexOf("]")) || "image"));
      case "fence": return div().text_size(11).text_color(t.dim).child(s);
      default: return div().child(s);
    }
  }

  // Writes the open block back into the document. `keep` leaves it open (a save while typing); otherwise it closes.
  commit(keep = false) {
    const e = this.edit;
    if (!e || !this.state) return;
    const text = this.state.value(), next = e.ta.value(), from = this.parsed;
    if (next !== e.src) {
      if (e.append) {
        if (next.trim()) {
          const r = appendBlock(text, next);
          this.state.set_value(r.text);
          Object.assign(e, { start: r.start, end: r.end, src: r.text.slice(r.start, r.end), append: false });
        }
      } else {
        const r = replaceBlock(text, e.start, e.end, next);
        this.state.set_value(r.text);
        this.moved = { from, at: r.at, delta: r.delta };
        Object.assign(e, { end: e.start + next.length, src: next });
      }
      this.dirty = this.state.value() !== this.original;
    }
    this.pending = false;
    if (keep) return;
    this.edit = null;
    e.ta.release();
  }

  block_textarea(e, t) {
    const text = e.ta.value(), mode = blockMode(text), first = parseMarker(text);
    const area = Textarea.new(e.ta).w_full()
      .token((ctx) => this.token_view(ctx, t))
      .on_token_click((ev, cx) => this.token_click(ev, cx));
    if (mode !== "rich") return area.font_family(settings().font_family).text_size(13);
    if (first.heading) return area.font_bold().text_size(HEADING[first.heading]);
    return area.when(first.quotes > 0, (el) => el.text_color(t.muted));
  }

  blockViews(t) {
    const { list, refs } = this.blocks(), e = this.edit, out = [];
    const tail = (b) => (refs && b.kind !== "code" ? "\n\n" + refs : "");
    const md = (b) => (b.kind === "front" ? "```yaml\n" + b.src.replace(/^---\r?\n|\r?\n---$/g, "") + "\n```" : b.src) + tail(b);
    const editor = (depth = 0) => div().id("block-edit").w_full().pl(8 + depth * 24).pr(8).mx(-8).py(2).rounded(6).border(1).border_color(t.border)
      .on_key_down((ev, cx) => { if (ev.keystroke === "escape") { this.commit(); cx.notify(); } })
      // Synthetic input (automation, accessibility tools) can report a press at (-1, -1); no real press lands off-window.
      .on_mouse_down_out((ev, cx) => { if (ev.position.x < 0 || ev.position.y < 0) return; this.commit(); cx.notify(); })
      .child(this.block_textarea(e, t));
    const view = (id, u, source, depth = 0) => div().id(id).w_full().pl(8 + depth * 24).pr(8).mx(-8).rounded(6).cursor_text()
      .hover((s) => s.bg(t.surface))
      .on_click((_ev, cx) => this.edit_block(u, cx))
      .child(TextView.markdown(`md-${this.file}-${id}`, source).on_link_click((url, cx) => { cx.stop_propagation(); this.link(url, cx); }));
    const editing = (u) => e && !e.append && u.end > e.start && u.start < e.end;
    // Where an emptied edit goes: before the first unit after it.
    const before = (u) => e && !e.append && !shown && u.start >= e.end;
    let shown = false;
    list.forEach((b, i) => {
      if (b.kind === "list") {
        const numbers = itemNumbers(b.items), rows = [];
        b.items.forEach((it, k) => {
          if (editing(it)) { if (!shown) { rows.push(editor(it.depth)); shown = true; } return; }
          if (before(it)) { rows.push(editor(it.depth)); shown = true; }
          rows.push(view(`item-${i}-${k}`, it, itemMarkdown(it, numbers[k]) + tail(it), it.depth));
        });
        // Items rendered one by one would each get a list's margins; a tight list keeps them together.
        const loose = /\n[ \t]*\r?\n/.test(b.src);
        out.push(v_flex().id(`list-${i}`).w_full().gap(loose ? 8 : 0).children(rows));
        return;
      }
      if (editing(b)) { if (!shown) { out.push(editor()); shown = true; } return; }
      if (before(b)) { out.push(editor()); shown = true; }
      // One TextView per block loses the margins a single rendered document puts above headings, so they come back here.
      out.push(view(`block-${i}`, b, md(b)).when(b.kind === "heading" && i > 0, (el) => el.mt(14)));
    });
    if (e && !shown) out.push(editor());
    if (!e?.append) out.push(div().id("block-append").w_full().min_h(48).flex_1().cursor_text()
      .on_click((_ev, cx) => this.edit_block({ append: true, start: 0, end: 0, src: "", kind: "paragraph" }, cx))
      .when(!list.length, (el) => el.text_color(t.dim).child("Click to start writing")));
    return out;
  }

  body(t) {
    if (this.error) return div().p(16).text_color(t.dim).child(this.error);
    if (!this.state) return div().p(16).text_color(t.dim).child("Loading…");
    if (this.mode === "preview") {
      const scroll = v_flex().id("preview").flex_1().min_h(0).overflow_y_scrollbar().px(40).py(24).text_size(15);
      if (this.on) return scroll.child(TextView.markdown(`md-${this.file}`, this.state.value()).selectable(true).on_link_click((url, cx) => this.link(url, cx)));
      return scroll.gap(10).children(this.blockViews(t));
    }
    return Editor.new(this.state).flex_1().min_h(0);
  }

  render(cx) {
    const req = shared("mayonaka-editor.open");
    if (req && req.n > this.seen) {
      this.seen = req.n;
      if (this.id && req.id === this.id) this.open(req, cx);
    }
    const t = theme();
    if (!this.file) return div().size_full().p(16).bg(t.background).text_color(t.dim).child("No file");
    return v_flex().id("mayonaka-editor").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(h_flex().h(34).flex_none().px(12).gap(6).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(h_flex().flex_1().min_w(0).gap(6).items_center().overflow_hidden().children(this.crumbs(t)))
        .when(this.dirty || this.pending, (el) => el.child(div().flex_none().size(7).rounded(4).bg(t.accent)))
        .when(Boolean(this.on), (el) => el.child(div().flex_none().text_color(t.dim).child("read-only")))
        .when(isMarkdown(this.file), (el) => el.child(h_flex().flex_none().gap(2).p(2).rounded(7).bg(t.surface)
          .child(this.toggle(t, "preview", "eye")).child(this.toggle(t, "source", "code")))))
      .child(this.body(t));
  }
}
