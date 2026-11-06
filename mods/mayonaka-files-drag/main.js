// A file or folder being dragged out of mayonaka-files. Opened as a transparent window over the whole app the moment a
// press on a row moves, it takes the rest of the gesture: a label follows the pointer, the pane under it lights up
// (mayonaka-pane), and letting go hands { action: "drop", pane } back to the panel, which types the path there.
// props { panel, path, dir, name, x, y }.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, closeOverlay, panes, spaces, shared, setShared, theme } from "herdr";

const RECTS = "mayonaka-pane.rects", DROP = "mayonaka-files.drop", ACTION = "mayonaka-files.action";

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

export default class FilesDrag extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.x = p.x ?? 0; this.y = p.y ?? 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.over = undefined;
    this.hover(this.x, this.y);
  }

  hover(x, y) {
    this.x = x; this.y = y;
    const pane = paneAt(x, y);
    if (pane !== this.over) { this.over = pane; setShared(DROP, pane ? { pane } : null); }
  }

  finish(drop) {
    const p = props();
    if (this.done) return;
    this.done = true;
    setShared(DROP, null);
    closeOverlay(p.overlay);
    const pane = drop ? paneAt(this.x, this.y) : null;
    if (pane) setShared(ACTION, { panel: p.panel, action: "drop", path: p.path, dir: p.dir, pane, n: Date.now() });
  }

  render() {
    const t = theme(), p = props() ?? {};
    return div().id("files-drag").track_focus(this.handle).size_full().cursor_pointer()
      .on_mouse_move((e, cx) => { this.hover(e.position.x, e.position.y); cx.notify(); })
      .on_mouse_up("left", (e) => { this.hover(e.position.x, e.position.y); this.finish(true); })
      // A release this window never saw (the button came up before it opened) leaves it open; the next press cancels.
      .on_mouse_down("left", () => this.finish(false))
      .on_mouse_down("right", () => this.finish(false))
      .on_key_down((e, cx) => { if (e.key === "escape") { this.finish(false); cx.stop_propagation(); } })
      .child(h_flex().absolute().left(this.x + 14).top(this.y + 10).h(26).px(9).gap(6).items_center().rounded(7)
        .bg(t.popover).border_1().border_color(this.over ? t.accent : t.border).text_size(12).text_color(t.foreground)
        .child(svg(`mods/mayonaka-files-drag/${p.dir ? "folder" : "file"}.svg`).size(13).flex_none().text_color(t.muted))
        .child(div().max_w(260).truncate().child(p.name ?? ""))
        .when(!this.over, (el) => el.opacity(0.7)));
  }
}
