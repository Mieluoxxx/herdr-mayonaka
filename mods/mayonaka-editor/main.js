// A file editor pane, opened beside the terminals by mayonaka-files: pane.split {mod: "mayonaka-editor", props: {id, file, on, root}}.
// mayonaka-files retargets an open editor through shared("mayonaka-editor.open") instead of splitting again.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { props, shared, setShared, readTextFile, writeTextFile, watchFolder, exec, notify, nextCommand, theme, settings } from "herdr";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", svelte: "html", vue: "html", md: "markdown", markdown: "markdown", py: "python", rs: "rust", sh: "bash", zsh: "bash" };
const MAX = 1024 * 1024;
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
        else if (c === "toggle" && isMarkdown(this.file)) this.mode = this.mode === "preview" ? "source" : "preview";
        cx.notify();
      }
    });
  }

  open({ file, on = null, root = null }, cx) {
    if (!file) return;
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
        else if (this.state) { if (!this.dirty && text !== this.original) { this.original = text; this.state.set_value(text); } }
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
      .on_click((_e, cx) => { this.mode = mode; cx.notify(); })
      .child(svg(`mods/mayonaka-editor/${icon}.svg`).size(14));
  }

  body(t) {
    if (this.error) return div().p(16).text_color(t.dim).child(this.error);
    if (!this.state) return div().p(16).text_color(t.dim).child("Loading…");
    if (this.mode === "preview")
      return v_flex().id("preview").flex_1().min_h(0).overflow_y_scrollbar().px(40).py(24).text_size(15)
        .child(TextView.markdown(`md-${this.file}`, this.state.value()).selectable(true).on_link_click((url, cx) => this.link(url, cx)));
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
        .when(this.dirty, (el) => el.child(div().flex_none().size(7).rounded(4).bg(t.accent)))
        .when(Boolean(this.on), (el) => el.child(div().flex_none().text_color(t.dim).child("read-only")))
        .when(isMarkdown(this.file), (el) => el.child(h_flex().flex_none().gap(2).p(2).rounded(7).bg(t.surface)
          .child(this.toggle(t, "preview", "eye")).child(this.toggle(t, "source", "code")))))
      .child(this.body(t));
  }
}
