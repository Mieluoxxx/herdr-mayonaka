import { View, div, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, Popup } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, settings, run } from "herdr";

const ROW = 24, LANE = 12, DOT = 3.5, MAX_LANES = 12, LIMIT = 600;
const CARD_W = 420, CARD_H = 340, CARD_GAP = 8;
// Same read-only flags as Changes: a refresh must not touch .git, or the folder
// watch sees it and every refresh starts the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const WORKTREE = "worktree";

// The same folder rule as mayonaka-files, so the graph is always the repository the Files panel shows.
let last = null;
function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  // A mod pane (an editor) has no folder: keep the repository it was opened from.
  if (pane?.mod && last?.space === space?.id) return last;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return last = { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
const key = () => JSON.stringify(location());

function parseRefs(text, remotes) {
  const refs = [];
  for (const raw of text.split(", ").filter(Boolean)) {
    if (raw === "HEAD") refs.push({ kind: "head", name: "HEAD" });
    else if (raw.startsWith("HEAD -> ")) refs.push({ kind: "head", name: raw.slice(8) });
    else if (raw.startsWith("tag: ")) refs.push({ kind: "tag", name: raw.slice(5) });
    else {
      const remote = remotes.find(r => raw.startsWith(r + "/"));
      if (remote && raw === `${remote}/HEAD`) continue;
      refs.push(remote ? { kind: "remote", name: raw.slice(remote.length + 1), remote } : { kind: "branch", name: raw });
    }
  }
  // A local branch and its remote copy on one commit read as one pill, "main · origin".
  const merged = [];
  for (const r of refs) {
    const local = r.kind === "remote" && refs.find(l => (l.kind === "branch" || l.kind === "head") && l.name === r.name);
    if (local) (local.remotes ??= []).push(r.remote);
    else merged.push(r);
  }
  return merged;
}

// Lanes hold the commit each one is waiting for. A row draws what passes through,
// what converges into its dot from above, and what leaves it for its parents.
function layoutGraph(commits) {
  const lanes = [];
  let color = 0;
  const free = () => { const i = lanes.findIndex(l => !l); return i < 0 ? lanes.length : i; };
  const rows = commits.map((c) => {
    const before = lanes.slice();
    let lane = lanes.findIndex(l => l?.hash === c.hash);
    const tip = lane < 0;
    if (tip) { lane = free(); lanes[lane] = { hash: c.hash, color: color++ }; }
    const own = lanes[lane].color, segs = [];
    before.forEach((l, j) => {
      if (!l) return;
      if (l.hash === c.hash) { segs.push({ half: "top", from: j, to: lane, color: l.color }); if (j !== lane) lanes[j] = null; }
      else segs.push({ half: "full", from: j, to: j, color: l.color });
    });
    const [first, ...rest] = c.parents;
    if (first) {
      const other = lanes.findIndex((l, j) => j !== lane && l?.hash === first);
      if (other >= 0) { segs.push({ half: "bottom", from: lane, to: other, color: own }); lanes[lane] = null; }
      else {
        // The uncommitted row hands HEAD's lane a real color of its own.
        lanes[lane] = { hash: first, color: c.hash === WORKTREE ? color++ : own };
        segs.push({ half: "bottom", from: lane, to: lane, color: own });
      }
    } else lanes[lane] = null;
    for (const p of rest) {
      let k = lanes.findIndex(l => l?.hash === p);
      if (k < 0) { k = free(); lanes[k] = { hash: p, color: color++ }; }
      segs.push({ half: "bottom", from: lane, to: k, color: lanes[k].color });
    }
    while (lanes.length && !lanes[lanes.length - 1]) lanes.pop();
    const span = Math.max(lane, ...segs.map(g => Math.max(g.from, g.to))) + 1;
    return { ...c, lane, color: own, tip, segs, span: Math.min(span, MAX_LANES) };
  });
  return rows;
}

function pad(n) { return String(n).padStart(2, "0"); }
// The panel is narrow: today's commits show the time, older ones only the day.
function shortDate(seconds) {
  const d = new Date(seconds * 1000), now = new Date();
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.getFullYear() === now.getFullYear() ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)}` : `${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function longDate(seconds) {
  const d = new Date(seconds * 1000);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default class GitGraph extends View {
  init(_props, cx) {
    this.rows = []; this.raw = null; this.selected = null; this.detail = null; this.dismissed = null; this.press = null; this.at = ROW;
    this.refresh(cx);
    cx.timer.every(15000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  refresh(cx) {
    // A change during a load asks for one more pass, so the last write is never missed.
    if (this.loading) { this.again = true; return; }
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.rows = []; this.raw = null;
      this.selected = null; this.detail = null; this.error = null; this.watched = null;
    }
    if (!cwd) return;
    this.loading = true; this.again = false;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.rows = []; this.raw = null; this.error = "Not a git repository"; return; }
        const root = top.stdout.trim(), git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const [log, head, status, remote] = await Promise.all([
          git(["log", "--branches", "--remotes", "--tags", "HEAD", "--date-order", "-n", String(LIMIT), "--pretty=format:%H%x1f%P%x1f%an%x1f%ct%x1f%D%x1f%s%x1e"]),
          git(["rev-parse", "--verify", "-q", "HEAD"]),
          git(["status", "--porcelain=v1", "--untracked-files=normal"]),
          git(["remote"]),
        ]);
        if (key() !== context) return;
        // An empty repository has no HEAD, and git log fails on it.
        if (log.code !== 0 && head.code === 0) throw new Error(log.stderr.trim());
        const raw = [log.stdout, head.stdout, status.stdout].join("\0");
        this.root = root; this.on = on; this.error = null; this.branch = null;
        this.watch(root, cx);
        if (raw === this.raw) return;
        this.raw = raw;
        const remotes = remote.stdout.split("\n").filter(Boolean);
        const commits = (log.code === 0 ? log.stdout : "").split("\x1e").map(s => s.replace(/^\n/, "")).filter(Boolean).map((line) => {
          const [hash, parents, author, time, refs, subject] = line.split("\x1f");
          return { hash, parents: parents ? parents.split(" ") : [], author, time: Number(time), refs: parseRefs(refs, remotes), subject };
        });
        const dirty = status.stdout.split("\n").filter(Boolean).length;
        const headHash = head.code === 0 ? head.stdout.trim() : null;
        if (dirty) commits.unshift({ hash: WORKTREE, parents: headHash ? [headHash] : [], author: "", time: 0, refs: [], subject: "Uncommitted Changes", dirty });
        this.rows = layoutGraph(commits); this.head = headHash; this.limited = commits.length - (dirty ? 1 : 0) >= LIMIT;
        if (this.selected && !this.rows.some(r => r.hash === this.selected)) { this.selected = null; this.detail = null; }
      } catch (e) { if (key() === context) this.error = String(e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) this.refresh(cx);
      }
    });
  }

  close(cx) { this.selected = null; this.detail = null; cx.notify(); }

  // A press outside the card closes it. Pressing the commit it belongs to is the first half of a click
  // that pick() sees next, so that click is remembered and must not reopen what the press just closed.
  dismiss(hash, e, cx) {
    // Synthetic input can report a press at (-1, -1); no real press lands off-window.
    if (e.position.x < 0 || e.position.y < 0 || this.selected !== hash) return;
    this.dismissed = { hash, at: Date.now() };
    this.close(cx);
  }

  pick(row, cx) {
    const gone = this.dismissed;
    this.dismissed = null;
    if (gone?.hash === row.hash && Date.now() - gone.at < 400) return;
    if (this.selected === row.hash) { this.close(cx); return; }
    // The list reports which commit was clicked, not where; the press that came just before it knows.
    this.at = this.press?.y ?? ROW;
    this.selected = row.hash; this.detail = row.hash === WORKTREE ? { worktree: true, dirty: row.dirty } : { loading: true };
    cx.notify();
    if (row.hash === WORKTREE) return;
    const root = this.root, on = this.on, hash = row.hash;
    cx.spawn(async (cx) => {
      try {
        const git = (args) => exec("git", [...READ, ...args], { cwd: root, on });
        const [info, files] = await Promise.all([
          git(["show", "-s", "--format=%an%x1f%ae%x1f%ct%x1f%P%x1f%B", hash]),
          git(["diff-tree", "--no-commit-id", "-r", "--name-status", "--root", "-m", "--first-parent", "--no-renames", hash]),
        ]);
        if (this.selected !== hash) return;
        if (info.code !== 0) throw new Error(info.stderr.trim());
        const [author, email, time, parents, body] = info.stdout.split("\x1f");
        const changed = files.stdout.split("\n").filter(Boolean).map((l) => { const [s, ...p] = l.split("\t"); return { status: s[0], path: p.join("\t") }; });
        this.detail = { author, email, time: Number(time), parents: parents.trim().split(" ").filter(Boolean), body: body.trim(), files: changed.slice(0, 300), more: Math.max(0, changed.length - 300) };
      } catch (e) { if (this.selected === hash) this.detail = { error: String(e) }; }
      cx.notify();
    });
  }

  palette(t) {
    return [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi1, t.ansi12, t.ansi10, t.ansi13, t.ansi11, t.ansi14, t.ansi9];
  }

  graphCell(row, t, colors, lanes) {
    const x = (lane) => lane * LANE + LANE / 2, mid = ROW / 2;
    const tint = (c) => colors[c % colors.length];
    const layers = row.segs.filter(s => s.from < MAX_LANES || s.to < MAX_LANES).map((s) => {
      const a = x(s.from), b = x(s.to), p = PathBuilder.stroke(1.5);
      if (s.half === "full") p.move_to(a, 0).line_to(a, ROW);
      else if (s.half === "top") (a === b ? p.move_to(a, 0).line_to(b, mid) : p.move_to(a, 0).cubic_bezier_to(b, mid, a, mid * 0.7, b, mid * 0.3));
      else (a === b ? p.move_to(a, mid).line_to(b, ROW) : p.move_to(a, mid).cubic_bezier_to(b, ROW, a, mid + mid * 0.7, b, mid + mid * 0.3));
      const color = row.hash === WORKTREE ? t.dim : tint(s.color);
      return window.paint_path(p.build(), color).absolute().top(0).left(0).size_full();
    });
    const cx = x(row.lane), color = row.hash === WORKTREE ? t.dim : tint(row.color);
    const circle = (r, fill) => PathBuilder[fill ? "fill" : "stroke"](fill ? undefined : 1.5).move_to(cx + r, mid).arc_to(r, r, 0, false, true, cx - r, mid).arc_to(r, r, 0, false, true, cx + r, mid).close().build();
    // Hollow dots: the uncommitted row and merges; a ring marks HEAD.
    const hollow = row.hash === WORKTREE || row.parents.length > 1;
    if (row.lane < MAX_LANES) {
      layers.push(window.paint_path(circle(DOT + (hollow ? 0.5 : 0), !hollow), hollow ? color : color).absolute().top(0).left(0).size_full());
      if (hollow) layers.push(window.paint_path(circle(DOT - 1, true), t.background).absolute().top(0).left(0).size_full());
      if (row.hash === this.head) layers.push(window.paint_path(circle(DOT + 2.5, false), t.foreground).absolute().top(0).left(0).size_full());
    }
    return div().relative().w(lanes * LANE + 4).h(ROW).flex_none().overflow_hidden().children(layers);
  }

  refPill(ref, color, t) {
    const label = ref.kind === "head" ? (ref.name === "HEAD" ? "HEAD" : `HEAD → ${ref.name}`) : ref.kind === "tag" ? `◆ ${ref.name}` : ref.kind === "remote" ? `${ref.remote}/${ref.name}` : ref.name;
    const tone = ref.kind === "tag" ? t.ansi3 : ref.kind === "remote" ? t.muted : color;
    const remotes = ref.remotes?.length ? ` · ${ref.remotes.join(" · ")}` : "";
    return h_flex().flex_none().max_w(140).h(16).px(5).items_center().overflow_hidden().rounded(4).border_1().border_color(tone + "88").bg(tone + "1f").text_size(10).text_color(tone)
      .when(ref.kind === "head", el => el.font_semibold())
      .child(div().flex_1().min_w(0).truncate().child(label + remotes));
  }

  row(row, t, colors, mono, lanes) {
    const color = row.hash === WORKTREE ? t.dim : colors[row.color % colors.length], on = this.selected === row.hash;
    return h_flex().id(`commit-${row.hash}`).w_full().h(ROW).flex_none().pr(10).gap(6).items_center().cursor_pointer()
      .when(on, el => el.bg(t.selected)).hover(s => s.bg(t.hover))
      .child(div().pl(6).flex_none().child(this.graphCell(row, t, colors, lanes)))
      .child(h_flex().flex_1().min_w(0).gap(4).items_center()
        .children(row.refs.slice(0, 3).map(r => this.refPill(r, color, t)))
        .when(row.refs.length > 3, el => el.child(div().flex_none().text_size(10).text_color(t.dim).child(`+${row.refs.length - 3}`)))
        .child(div().min_w(0).truncate().text_color(row.hash === WORKTREE ? t.muted : t.foreground).when(row.hash === WORKTREE, el => el.italic()).child(row.subject)))
      .when(row.hash !== WORKTREE, el => el
        .child(div().flex_none().font_family(mono).text_size(10.5).text_color(t.dim).child(row.hash.slice(0, 7)))
        .child(div().w(48).flex_none().text_right().font_family(mono).text_size(10.5).text_color(t.dim).child(shortDate(row.time))))
      .when(row.hash === WORKTREE, el => el.child(div().flex_none().text_size(11).text_color(t.blocked).child(`${row.dirty} files`)));
  }

  // The card floats above the window, to the left of the panel and level with the row that was pressed, so it
  // covers neither the list nor the row. top_right pins its top right corner to the bottom right of a 1px
  // trigger on the list's left edge; the gap is padding, since the card is the only thing that may be drawn.
  // It is built here and not in the row renderer: a handler registered there throws.
  floating(card) {
    return Popup.new("gitgraph-card", div().w(1).h(1)).absolute().top(Math.max(0, this.at - ROW / 2)).left(0)
      .anchor("top_right").content(div().pr(CARD_GAP).child(card));
  }

  details(t, mono) {
    const d = this.detail, row = this.rows.find(r => r.hash === this.selected);
    if (!d || !row) return null;
    // overflow_y_scrollbar() never scrolls a box that only has a max height, so the box scrolls itself
    // and the bar is placed beside it. The id carries the commit, so each one opens at its top.
    const id = `gitgraph-detail-${row.hash}`;
    const box = v_flex().id(id).max_h(CARD_H).overflow_y_scroll().p(12).gap(6).text_size(12);
    // The card covers rows, so a press on it is kept from reaching them.
    const wrap = (el) => div().id("gitgraph-card").relative().flex_none().w(CARD_W).bg(t.popover).text_color(t.foreground)
      .border_1().border_color(t.border).rounded(10).shadow_lg().overflow_hidden()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_mouse_down_out((e, cx) => this.dismiss(row.hash, e, cx))
      .child(el).child(Scrollbar.vertical(id).absolute().inset_0());
    if (d.worktree) return wrap(box
      .child(div().text_color(t.muted).child(`${d.dirty} uncommitted ${d.dirty === 1 ? "file" : "files"} on top of HEAD.`))
      .child(div().id("open-changes").flex_none().h(26).px(10).flex().items_center().rounded(6).bg(t.raised).hover(s => s.bg(t.hover)).cursor_pointer()
        .on_click(() => run("layout.select", { stack: "panel-body", child: "changes" })).child("Open in Changes")));
    if (d.loading) return wrap(box.child(div().text_color(t.dim).child("Loading…")));
    if (d.error) return wrap(box.child(div().text_color(t.ansi1).child(d.error)));
    const [subject, ...rest] = d.body.split("\n");
    const tone = (s) => s === "A" ? t.ansi2 : s === "D" ? t.ansi1 : s === "R" ? t.ansi4 : t.blocked;
    return wrap(box
      .child(div().font_semibold().child(subject || row.subject))
      .when(Boolean(rest.join("\n").trim()), el => el.child(div().text_color(t.muted).child(rest.join("\n").trim())))
      .child(h_flex().gap(6).text_size(11).text_color(t.dim).flex_wrap()
        .child(div().text_color(t.muted).child(d.author)).child(div().child(`<${d.email}>`)).child(div().child(longDate(d.time))))
      .child(h_flex().gap(6).text_size(10.5).font_family(mono).text_color(t.dim)
        .child(div().child(row.hash.slice(0, 12)))
        .when(d.parents.length > 0, el => el.child(div().child(`← ${d.parents.map(p => p.slice(0, 7)).join(" ")}`))))
      .child(v_flex().gap(2).pt(4).children(d.files.map(f => {
        const parts = f.path.split("/"), name = parts.pop();
        return h_flex().h(20).gap(8).items_center().text_size(11.5)
          .child(div().w(12).flex_none().text_size(10.5).text_color(tone(f.status)).child(f.status))
          .child(h_flex().flex_1().min_w(0).child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : "")).child(div().flex_none().max_w(220).truncate().child(name)));
      })).when(d.more > 0, el => el.child(div().text_size(11).text_color(t.dim).child(`and ${d.more} more`)))
        .when(!d.files.length, el => el.child(div().text_size(11).text_color(t.dim).child("No file changes")))));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    const t = theme(), colors = this.palette(t), mono = settings().font_family ?? "JetBrains Mono";
    const count = this.rows.filter(r => r.hash !== WORKTREE).length;
    const branch = this.rows.flatMap(r => r.refs).find(r => r.kind === "head");
    const card = this.detail ? this.details(t, mono) : null;
    return v_flex().id("gitgraph").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().text_size(13).font_semibold().child("Graph"))
        .when(Boolean(branch), el => el.child(div().min_w(0).truncate().text_size(11).text_color(t.muted).child(branch.name)))
        .child(div().flex_1())
        .child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).child(`${count}${this.limited ? "+" : ""} ${count === 1 ? "commit" : "commits"}`)))
      .child(div().id("gitgraph-body").flex_1().min_h(0).relative()
        .on_mouse_down("left", (e) => { this.press = e.local_position ?? null; })
        .child(v_virtual_list("gitgraph-list", this.rows.length, ROW, (i) => this.rows[i].hash,
          // The graph column fits the rows on screen, so one wide stretch of history
          // doesn't squeeze every subject.
          (range) => {
            const shown = this.rows.slice(range.start, range.end), lanes = Math.max(1, ...shown.map(r => r.span));
            return shown.map((row) => this.row(row, t, colors, mono, lanes));
          })
          // Rows are rebuilt every frame, so clicks go through the list, by commit hash.
          .on_item_click((hash, cx) => { const row = this.rows.find(r => r.hash === hash); if (row) this.pick(row, cx); })
          .size_full().py(4))
        .child(Scrollbar.vertical("gitgraph-list").viewport_from_layout().absolute().inset_0())
        .when(!this.rows.length, el => el.child(div().absolute().top(8).px(14).text_color(t.dim)
          .child(this.error || (this.loading ? "Loading history…" : this.root ? "No commits yet" : "No folder"))))
        .when(Boolean(card), el => el.child(this.floating(card))));
  }
}
