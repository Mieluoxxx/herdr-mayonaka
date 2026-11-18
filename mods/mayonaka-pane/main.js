// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "mayonaka-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; for mayonaka-editor file cards,
// shows the file's Material icon, its file name, its parent relative path, unsaved dot, and
// preview/source toggle; buttons split, zoom and close this pane. Props from the app: { pane, terminal }.
// Click: focus the pane.
// Herdr gives mods no pane geometry, so each header records where it is on every press (anywhere, through
// on_mouse_down_out) in shared("mayonaka-pane.rects"); mayonaka-files uses it for drag targets and smart tiling.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { fileIcon, iconPath } from "./material.js";
import { panes, props, run, theme, home, shared, setShared } from "herdr";

const RECTS = "mayonaka-pane.rects", DROP = "mayonaka-files.drop";

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

function baseName(file) {
  return (file ?? "").split("/").pop() || "";
}

function editorDirPath(info) {
  const file = info?.file;
  if (!file) return "";
  const slash = file.lastIndexOf("/");
  if (slash <= 0) return "";
  const dir = file.slice(0, slash);
  if (info?.root) {
    if (dir === info.root) return "";
    if (dir.startsWith(info.root + "/")) {
      return dir.slice(info.root.length + 1).split("/").join(" › ");
    }
  }
  return folder(dir).replace(/^\//, "").split("/").join(" › ");
}

export default class Pane extends View {
  init() { this.hovered = false; }

  report(e) {
    const b = e.bounds, pane = props()?.pane;
    if (!b || !pane) return;
    const rects = shared(RECTS) ?? {}, old = rects[pane];
    if (old && old.x === b.x && old.y === b.y && old.w === b.width) return;
    const live = new Set(panes().map((p) => p.pane)), next = { [pane]: { x: b.x, y: b.y, w: b.width } };
    for (const [id, r] of Object.entries(rects)) if (id !== pane && live.has(id)) next[id] = r;
    setShared(RECTS, next);
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  actionButton(t, id, iconName, onClick) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => {
        cx.stop_propagation();
        onClick(e, cx);
      })
      .child(svg(`mods/mayonaka-pane/${iconName}.svg`).size(14));
  }

  modeButton(t, pane, editorId, curMode, which, iconName) {
    const on = curMode === which;
    return div()
      .id(`ph-mode-${pane}-${which}`)
      .size(18)
      .flex()
      .items_center()
      .justify_center()
      .rounded(4)
      .cursor_pointer()
      .bg(on ? t.selected : t.surface)
      .text_color(on ? t.foreground : t.muted)
      .hover((s) => s.bg(on ? t.selected : t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run("pane.focus", { pane });
        if (curMode !== which) {
          setShared("mayonaka-editor.target", { id: editorId, mode: which, n: Date.now() });
          run("mayonaka-editor.set-mode");
        }
      })
      .child(svg(`mods/mayonaka-editor/${iconName}.svg`).size(12));
  }

  render() {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const pane = p.pane, target = shared(DROP)?.pane === pane;
    const isEditor = p.mod === "mayonaka-editor";
    const editorId = isEditor ? (shared("mayonaka-editor.ids") ?? {})[pane] : null;
    const editorInfo = editorId ? (shared("mayonaka-editor.files") ?? {})[editorId] : null;
    const activeFile = editorInfo?.file ?? null;
    const fileBase = activeFile ? baseName(activeFile) : "";
    const name = isEditor
      ? (fileBase || "Editor")
      : ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = isEditor
      ? (fileBase
        ? image(iconPath(fileIcon(fileBase))).w(14).h(14).flex_none()
        : svg("mods/mayonaka-editor/file.svg").size(14).flex_none().text_color(t.dim))
      : icon(p.program, 14, t.dim);
    const subtitle = isEditor ? editorDirPath(editorInfo) : folder(p.cwd);
    const hasPreview = Boolean(isEditor && editorInfo?.hasPreview && editorId);
    const editorMode = editorInfo?.mode ?? "source";
    const st = p.status;

    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .border_b(1)
      .border_color(target ? t.accent : t.border)
      .when(target, (el) => el.bg(t.selected))
      .text_size(12)
      .on_mouse_down_out((e) => this.report(e))
      .on_mouse_down("left", (e) => this.report(e))
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(240).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(subtitle))
      .when(Boolean(isEditor && editorInfo?.dirty), (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.accent)))
      .when(hasPreview, (el) => el.child(
        h_flex().flex_none().gap(1).p(2).rounded(6).bg(t.surface)
          .child(this.modeButton(t, pane, editorId, editorMode, "preview", "eye"))
          .child(this.modeButton(t, pane, editorId, editorMode, "source", "code")),
      ))
      .when(st === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, (el) => el
        .child(this.actionButton(t, `ph-r-${pane}`, "split-right", () => run("pane.split", { direction: "right", pane })))
        .child(this.actionButton(t, `ph-d-${pane}`, "split-down", () => run("pane.split", { direction: "down", pane })))
        .child(this.actionButton(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", () => run("pane.zoom", { pane })))
        .child(this.actionButton(t, `ph-x-${pane}`, "close", () => {
          if (isEditor && editorId) {
            setShared("mayonaka-editor.target", { id: editorId, n: Date.now() });
            run("mayonaka-editor.close-pane");
          } else {
            run("pane.close", { pane });
          }
        })));
  }
}
