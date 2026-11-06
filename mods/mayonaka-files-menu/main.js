// The Files panel's right-click menu, and the name and delete dialogs it leads to. Opened by mayonaka-files with
// props { stage: "menu" | "name" | "delete", items (menu rows the panel built), panel, path ("" is the panel's folder), dir, name, on }.
// It only asks: the chosen action goes back through shared("mayonaka-files.action") and the panel does the file work.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, openOverlay, setShared, theme, window } from "herdr";

const icon = (name) => `mods/mayonaka-files-menu/${name}.svg`;

function badName(name, current) {
  if (!name.trim()) return "Enter a name";
  if (name === "." || name === "..") return "Not a usable name";
  if (/[\\/]/.test(name)) return "A name can't contain / or \\";
  if (name === current) return "Same as the current name";
  return null;
}

export default class FilesMenu extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.at = 0;
    this.handle = cx.focus_handle();
    if (p.stage === "name") {
      this.text = p.action === "rename" ? p.name : "";
      this.input = InputState.new({ value: this.text });
      // Select the stem so typing replaces the name and keeps the extension, as Finder does.
      const dot = this.text.lastIndexOf(".");
      if (this.text) this.input.set_selected_range({ start: 0, end: dot > 0 ? dot : this.text.length });
      this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
      this.input.on("submit", () => this.submitName());
      this.input.focus();
      // The dialog takes focus a moment after it opens; ask again so typing lands in the field.
      cx.timer.after(300, () => this.input.focus());
    } else this.handle.focus();
  }

  post(action, extra = {}) {
    const p = props();
    closeOverlay(p.overlay);
    setShared("mayonaka-files.action", { panel: p.panel, action, path: p.path, dir: p.dir, ...extra, n: Date.now() });
  }

  choose(item) {
    const p = props();
    if (!item) return;
    if (item.action === "new-file" || item.action === "new-folder" || item.action === "rename") {
      closeOverlay(p.overlay);
      openOverlay({ mod: "mayonaka-files-menu", kind: "dialog", width: 400, height: 206, props: { ...p, items: undefined, overlay: undefined, stage: "name", action: item.action } });
    } else if (item.action === "delete") {
      closeOverlay(p.overlay);
      openOverlay({ mod: "mayonaka-files-menu", kind: "dialog", width: 400, height: 176, props: { ...p, items: undefined, overlay: undefined, stage: "delete" } });
    } else this.post(item.action);
  }

  submitName() {
    const p = props();
    if (badName(this.text, p.action === "rename" ? p.name : null)) return;
    this.post(p.action, { name: this.text });
  }

  button(id, label, primary, action, danger = false) {
    const t = theme(), bg = danger ? t.ansi1 : primary ? t.solid : t.raised;
    return h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1().border_color(primary || danger ? bg : t.input).bg(bg)
      .text_color(danger ? t.background : primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(label);
  }

  header(title) {
    const t = theme();
    return h_flex().items_center().child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title))
      .child(div().text_size(11).text_color(t.dim).child("Esc"));
  }

  renderName() {
    const t = theme(), p = props();
    const title = p.action === "rename" ? `Rename ${p.name}` : p.action === "new-folder" ? "New folder" : "New file";
    const where = p.path ? `in ${p.path}` : `in ${p.root ?? "this folder"}`;
    const untouched = this.text === (p.action === "rename" ? p.name : "");
    const problem = untouched ? null : badName(this.text, p.action === "rename" ? p.name : null);
    return v_flex().id("files-menu-name").w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .on_key_down((e, cx) => { if (e.key === "escape") { closeOverlay(props().overlay); cx.stop_propagation(); } })
      .child(this.header(title))
      .child(div().pt(4).text_size(11.5).text_color(t.dim).truncate().child(p.action === "rename" ? (p.path.includes("/") ? `in ${p.path.slice(0, p.path.lastIndexOf("/"))}` : "") : where))
      .child(Input.new(this.input).mt(12).h(36).px(10).rounded(9).border_1().border_color(problem ? t.ansi1 : t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(div().h(18).pt(5).text_size(11.5).text_color(t.ansi1).child(problem ?? ""))
      .child(h_flex().pt(10).gap(8).justify_end()
        .child(this.button("fm-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(this.button("fm-save", p.action === "rename" ? "Rename" : "Create", true, () => this.submitName())));
  }

  renderDelete() {
    const t = theme(), p = props();
    const trash = !p.on && window()?.platform === "macos";
    const what = p.dir ? "This folder and everything in it" : "This file";
    return v_flex().id("files-menu-delete").track_focus(this.handle).size_full().min_h(0).p(18).gap(12).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "enter") this.post("delete");
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.stop_propagation();
      })
      .child(this.header(`Delete ${p.name}?`))
      .child(div().flex_1().min_h(0).text_color(t.muted).child(trash ? `${what} will be moved to the Trash.` : `${what} will be deleted permanently. This can't be undone.`))
      .child(h_flex().justify_end().gap(8)
        .child(this.button("fm-no", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(this.button("fm-yes", trash ? "Move to Trash" : "Delete", false, () => this.post("delete"), true)));
  }

  render() {
    const p = props() ?? {};
    if (p.stage === "name") return this.renderName();
    if (p.stage === "delete") return this.renderDelete();
    const t = theme(), list = p.items ?? [];
    return v_flex().id("files-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(list[this.at]);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => v_flex()
        .when(it.sep, (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`fm-${it.action}`).h(31).px(8).gap(9).rounded(7).items_center().cursor_pointer()
          .text_color(it.danger ? t.ansi1 : t.foreground)
          .when(i === this.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.choose(it))
          .child(svg(icon(it.icon)).size(14).flex_none().text_color(it.danger ? t.ansi1 : t.muted))
          .child(div().flex_1().child(it.label)))));
  }
}
