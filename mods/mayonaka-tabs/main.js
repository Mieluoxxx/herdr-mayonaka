import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, focused, run, openOverlay, theme, window, shared, setShared, layout, settings, nextCommand } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function pickReopenSplit(tabPanes, editors, f) {
  if (editors.length === 0) {
    const anchor = (f?.pane && tabPanes.find((p) => p.pane === f.pane))
      ?? tabPanes.find((p) => p.focused)
      ?? tabPanes.find((p) => !p.mod)
      ?? tabPanes[0];
    return { pane: anchor?.pane ?? null, direction: "right" };
  }
  if (editors.length === 1) return { pane: editors[0].pane, direction: "down" };
  const rects = shared("mayonaka-pane.rects") ?? {};
  const withRects = editors.filter((p) => rects[p.pane]?.w > 0);
  if (withRects.length >= 2) {
    const byWidth = [...withRects].sort((a, b) => {
      const ra = rects[a.pane], rb = rects[b.pane];
      return rb.w - ra.w || ra.y - rb.y || ra.x - rb.x;
    });
    if (rects[byWidth[0].pane].w >= 520) return { pane: byWidth[0].pane, direction: "right" };
    const cols = [];
    for (const p of [...withRects].sort((a, b) => rects[a.pane].x - rects[b.pane].x || rects[a.pane].y - rects[b.pane].y)) {
      const r = rects[p.pane];
      const col = cols.find((c) => Math.abs(c.x - r.x) <= 32);
      if (col) col.panes.push(p);
      else cols.push({ x: r.x, panes: [p] });
    }
    cols.sort((a, b) => a.panes.length - b.panes.length || a.x - b.x);
    const chosen = cols[0].panes;
    return { pane: chosen[chosen.length - 1].pane, direction: "down" };
  }
  if (editors.length === 2) return { pane: editors[0].pane, direction: "right" };
  if (editors.length === 3) return { pane: editors[1].pane, direction: "right" };
  return { pane: editors[editors.length - 1].pane, direction: "down" };
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    // Keys press the same side-panel toggles as the buttons in this bar.
    cx.spawn(async (cx) => {
      for (;;) {
        const id = await nextCommand();
        if (id === "files-search") {
          run("layout.select", { stack: "panel-body", child: "files" });
          run("layout.show", { id: "panel" });
          setShared("mayonaka-files.search", { n: Date.now() });
          cx.notify();
        } else if (id === "reopen-file") {
          this.reopenClosedFile(cx);
          cx.notify();
        } else if (id) {
          this.togglePanel(id);
          cx.notify();
        }
      }
    });
  }

  reopenClosedFile(cx) {
    const list = shared("mayonaka-editor.closed");
    if (!Array.isArray(list) || !list.length) return;
    const item = list[list.length - 1];
    setShared("mayonaka-editor.closed", list.slice(0, -1));
    if (!item?.file) return;
    const f = focused();
    const tabId = f?.tab ?? spaces().find((s) => s.active)?.tabs?.find((t) => t.active)?.id;
    const allPanes = panes(), ids = shared("mayonaka-editor.ids") ?? {}, filesMap = shared("mayonaka-editor.files") ?? {};
    const tabPanes = tabId ? allPanes.filter((p) => p.tab === tabId) : [];
    const editors = tabPanes.filter((p) => p.mod === "mayonaka-editor" && ids[p.pane]);
    const existing = editors.find((p) => {
      const info = filesMap[ids[p.pane]];
      return info?.file === item.file && (info.on ?? null) === (item.on ?? null);
    });
    if (existing) {
      run("pane.focus", { pane: existing.pane });
      return;
    }
    const { pane, direction } = pickReopenSplit(tabPanes, editors, f);
    const id = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    run("pane.split", {
      direction,
      ...(pane ? { pane } : {}),
      mod: "mayonaka-editor",
      props: { id, file: item.file, on: item.on ?? null, root: item.root ?? null, ...(item.mode ? { mode: item.mode } : {}) },
    });
    cx.spawn(async () => {
      await cx.sleep(60);
      const curIds = shared("mayonaka-editor.ids") ?? {};
      const fresh = panes().find((p) => p.tab === tabId && p.mod === "mayonaka-editor" && !curIds[p.pane]);
      if (fresh) setShared("mayonaka-editor.ids", { ...curIds, [fresh.pane]: id });
    });
  }

  // Show the panel on that child, or hide it when it already shows that one.
  togglePanel(id) {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (panel && !panel.hidden && body?.active === id) run("layout.hide", { id: "panel" });
    else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => {
          cx.stop_propagation();
          const command = { name: "tab.close", args: { id: c.id } };
          if (c.status !== "working") return run(command.name, command.args);
          openOverlay({ mod: "confirm", kind: "dialog", width: 380, height: 168, props: { title: `Close ${name}?`, detail: `${program?.name ?? "An agent"} is still working in this tab. Closing it stops the task.`, command } });
        }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // Graph isn't one of Herdr's panels, so the welcome's choice never lists it:
    // the button follows the layout having the block.
    const graph = body?.children?.some(c => c.id === "gitgraph") ? ["gitgraph"] : [];
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), ...graph];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => this.togglePanel(id)).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      // 543: the shipped menu's 512 plus the Browser row mayonaka-new-menu adds.
      .child(button("tab-new", "+", () => openOverlay({ mod: "mayonaka-new-menu", kind: "popup", width: 250, height: 543 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(enabled.includes("gitgraph"), el => el.child(panelButton("gitgraph", "Graph", "mods/mayonaka-gitgraph/git-graph.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/mayonaka-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/mayonaka-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/mayonaka-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
