// A row being dragged out of mayonaka-files. Opened as a transparent window over the whole app the moment a
// press on a row moves, it takes the rest of the gesture: a label follows the pointer, the folder under it
// (or the panel's header, for the panel's own folder) lights up, the pane under it lights up (mayonaka-pane),
// and letting go hands the drop back to the panel: { action: "move", to } inside the tree, or
// { action: "drop", pane } onto a terminal, whose path is typed there.
// props from the panel: { panel, path, dir, parent, name, root, icon, x, y }, plus what target.js needs to find a
// folder row: { cols, rowH, first, last, folders, header, tree }. icon is the row's Material icon.
import { View, div, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, closeOverlay, panes, spaces, shared, setShared, theme, settings } from "herdr";
import { moveTargetAt } from "./target.js";

const RECTS = "mayonaka-pane.rects", DROP = "mayonaka-files.drop", ACTION = "mayonaka-files.action", DRAG = "mayonaka-files.drag";

// Panes tile their tab, so the one holding the point is the one whose header is the nearest above it, across its width.
function paneAt(x, y) {
  const tab = spaces().find((s) => s.active)?.tabs.find((c) => c.active)?.id, rects = shared(RECTS) ?? {};
  let best = null;
  for (const p of panes()) {
    const r = rects[p.pane];
    if (p.tab !== tab || !p.terminal || !r || x < r.x || x > r.x + r.w || y < r.y) continue;
    if (!best || r.y > best.y) best = { pane: p.pane, y: r.y };
  }
  return best?.pane ?? null;
}

const baseName = (path) => path.split("/").pop() ?? path;

export default class FilesDrag extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.x = p.x ?? 0; this.y = p.y ?? 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.over = undefined;
    this.move = null;
    // The panel stops reloading its tree while this is set: the folder rows it measured must stay where they were.
    setShared(DRAG, { panel: p.panel, n: Date.now() });
    this.hover(this.x, this.y);
  }

  hover(x, y) {
    this.x = x; this.y = y;
    this.move = moveTargetAt(props() ?? {}, x, y);
    const pane = this.move ? null : paneAt(x, y);
    // Every setShared re-renders every mod, so it is only written when the pane under the pointer changes.
    if (pane !== this.over) { this.over = pane; setShared(DROP, pane ? { pane } : null); }
  }

  finish(drop) {
    const p = props();
    if (this.done) return;
    this.done = true;
    setShared(DROP, null);
    setShared(DRAG, null);
    closeOverlay(p.overlay);
    if (!drop) return;
    if (this.move) return setShared(ACTION, { panel: p.panel, action: "move", path: p.path, dir: p.dir, to: this.move.to, n: Date.now() });
    const pane = paneAt(this.x, this.y);
    if (pane) setShared(ACTION, { panel: p.panel, action: "drop", path: p.path, dir: p.dir, pane, n: Date.now() });
  }

  render() {
    // Pointer positions and measured rectangles are window pixels; lengths drawn here are multiplied by the zoom.
    const z = settings().zoom || 1, r = this.move?.rect;
    const t = theme(), p = props() ?? {}, label = this.move ? (this.move.to ? baseName(this.move.to) : p.root || "this folder") : null;
    return div().id("files-drag").track_focus(this.handle).size_full().cursor_pointer()
      .on_mouse_move((e, cx) => { this.hover(e.position.x, e.position.y); cx.notify(); })
      .on_mouse_up("left", (e) => { this.hover(e.position.x, e.position.y); this.finish(true); })
      // A release this window never saw (the button came up before it opened) leaves it open; the next press cancels.
      .on_mouse_down("left", () => this.finish(false))
      .on_mouse_down("right", () => this.finish(false))
      .on_key_down((e, cx) => { if (e.key === "escape") { this.finish(false); cx.stop_propagation(); } })
      .when(Boolean(this.move), (el) => el.child(div().absolute().left(r.x / z).top(r.y / z).w(r.w / z).h(r.h / z).rounded(7)
        .bg(t.accent).opacity(0.18).border_1().border_color(t.accent)))
      .child(h_flex().absolute().left(this.x / z + 14).top(this.y / z + 10).h(26).px(9).gap(6).items_center().rounded(7)
        .bg(t.popover).border_1().border_color(this.over || this.move ? t.accent : t.border).text_size(12).text_color(t.foreground)
        .child(image(p.icon).w(14).h(14).flex_none())
        .child(div().max_w(260).truncate().child(p.name ?? ""))
        .when(Boolean(label), (el) => el.child(div().flex_none().max_w(180).truncate().text_color(t.muted).child(`→ ${label}`)))
        .when(!this.over && !this.move, (el) => el.opacity(0.7)));
  }
}
