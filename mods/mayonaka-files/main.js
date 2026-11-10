// A lazy file browser for the focused pane's folder. Files open in an editor pane beside the terminals (⌘-click: a new split).
// Right-click opens mods/mayonaka-files-menu, which hands the chosen action back through shared("mayonaka-files.action").
// Dragging a row opens mods/mayonaka-files-drag; dropping it on a terminal pane types the path there, and dropping it
// on another folder row (or the header, or the tree's blank space) moves it there.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { fileIcon, folderIcon, iconPath } from "./material.js";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, run, shared, setShared, openOverlay, notify } from "herdr";

let last = null;
function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  // A mod pane (the editor this panel opened) has no folder: keep showing the tree it was opened from.
  if (pane?.mod && last?.space === space?.id) return last;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return last = { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
// mods/mayonaka-editor never learns its own pane id, so this panel remembers which editor id each pane it split holds.
const editorIds = () => shared("mayonaka-editor.ids") ?? {};
const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const ACTION = "mayonaka-files.action", DRAG = "mayonaka-files.drag";
// Rows are a flat list of one height with no gap: a drag places every folder row from the pressed row's rectangle.
const ROW_H = 28;

const join = (root, path) => (path ? `${root}/${path}` : root);
const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseName = (path) => path.split(/[\\/]/).pop();
const shellQuote = (path) => (/^[\w@%+=:,./~-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`);
const rectOf = (b) => (b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null);

// One file operation, on the pane's machine. Windows here has no sh, so it goes through PowerShell like the listing does.
async function fsop(kind, a, b, on) {
  if (!on && window()?.platform === "windows") {
    const q = (p) => "'" + p.replace(/['‘’‚‛]/g, "$&$&") + "'";
    const mv = `if (Test-Path -LiteralPath ${q(b ?? "")}) { throw 'Already exists' }; Move-Item -LiteralPath ${q(a)} -Destination ${q(b ?? "")}`;
    const ps = {
      "new-file": `if (Test-Path -LiteralPath ${q(a)}) { throw 'Already exists' }; New-Item -ItemType File -Path ${q(a)} | Out-Null`,
      "new-folder": `if (Test-Path -LiteralPath ${q(a)}) { throw 'Already exists' }; New-Item -ItemType Directory -Path ${q(a)} | Out-Null`,
      rename: mv,
      move: mv,
      delete: `Remove-Item -LiteralPath ${q(a)} -Recurse -Force`,
    }[kind];
    const r = await exec("powershell", ["-NoProfile", "-Command", `$ErrorActionPreference = 'Stop'; ${ps}`]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Failed");
    return;
  }
  const exists = 'if [ -e "$1" ] || [ -L "$1" ]; then echo "${1##*/} already exists" >&2; exit 1; fi; ';
  // A rename and a drop inside the tree are the same move: an existing name is refused, so mv never moves into a folder.
  const mv = 'if [ -e "$2" ] || [ -L "$2" ]; then echo "${2##*/} already exists" >&2; exit 1; fi; mv -- "$1" "$2"';
  const sh = {
    "new-file": exists + ': > "$1"',
    "new-folder": exists + 'mkdir -- "$1"',
    rename: mv,
    move: mv,
    // macOS has /usr/bin/trash since 15; elsewhere, and on other machines, delete means delete.
    delete: on || window()?.platform !== "macos" ? 'rm -rf -- "$1"' : 'if command -v trash >/dev/null 2>&1; then trash "$1"; else osascript -e \'on run argv\' -e \'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)\' -e \'end run\' "$1" >/dev/null; fi',
  }[kind];
  const r = await exec("sh", ["-c", sh, "files", a, ...(b ? [b] : [])], { on });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Failed");
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object { @('.git', '.DS_Store', 'Thumbs.db', 'desktop.ini') -notcontains $_.Name -and $_.Name -notlike '._*' } | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; case $name in .git|.DS_Store|Thumbs.db|desktop.ini|._*) continue;; esac; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    // shared() is persisted; a fresh id per copy keeps an action from an earlier run or another Files panel from replaying here.
    this.panelId = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    if (this.dragging) return;
    const { cwd, on } = location(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.file });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  claimSplit() {
    if (!this.pendingId) return;
    const ids = editorIds(), fresh = panes().find(p => p.mod === "mayonaka-editor" && !ids[p.pane]);
    if (!fresh) return;
    setShared("mayonaka-editor.ids", { ...ids, [fresh.pane]: this.pendingId });
    this.lastEditor = fresh.pane; this.pendingId = null;
  }

  openFile(path, split) {
    const file = `${this.root}/${path}`, on = this.on, root = this.root, f = focused(), ids = editorIds();
    const editors = panes().filter(p => p.mod === "mayonaka-editor" && p.tab === f?.tab && ids[p.pane]);
    const target = editors.find(p => p.focused) ?? editors.find(p => p.pane === this.lastEditor) ?? editors[editors.length - 1];
    if (target && !split) {
      setShared("mayonaka-editor.open", { id: ids[target.pane], file, on, root, n: Date.now() });
      this.lastEditor = target.pane;
      run("pane.focus", { pane: target.pane });
      return;
    }
    const id = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.pendingId = id;
    run("pane.split", { direction: "right", ...(target ? { pane: target.pane } : {}), mod: "mayonaka-editor", props: { id, file, on, root } });
    this.claimSplit();
  }

  openedFile() {
    const f = focused(), pane = f?.pane && panes().find(p => p.pane === f.pane);
    const id = editorIds()[pane?.mod === "mayonaka-editor" ? pane.pane : this.lastEditor];
    return id ? shared("mayonaka-editor.files")?.[id]?.file : null;
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(`${root}/${path}`, { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop() : "txt";
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  menuItems(path, dir) {
    const local = !this.on, root = !path, platform = window()?.platform, items = [];
    const add = (label, action, icon, sep = false, danger = false) => items.push({ label, action, icon, sep: sep && items.length > 0, danger });
    if (dir) { add("New File…", "new-file", "plus"); add("New Folder…", "new-folder", "folder-plus"); }
    else add("Open", "open", "file-text");
    if (local && !dir) add("Open with Default App", "open-default", "external-link", true);
    if (local) add(platform === "macos" ? "Reveal in Finder" : platform === "windows" ? "Show in Explorer" : "Open Containing Folder", "reveal", "folder", dir);
    add("Copy Path", "copy-path", "copy", true);
    if (!root) add("Copy Relative Path", "copy-relative", "copy");
    if (root) add("Refresh", "refresh", "refresh", true);
    else { add("Rename…", "rename", "square-pen", true); add("Delete", "delete", "trash", false, true); }
    return items;
  }

  dragFrom(e) {
    const p = this.press;
    if (!p || Math.hypot(e.position.x - p.x, e.position.y - p.y) < 6) return;
    this.press = null;
    this.dragging = true;
    setShared(DRAG, { panel: this.panelId, n: Date.now() });
    // Only the pressed row's rectangle will do: by now the pointer may be over its neighbour, whose index is not p.index.
    const flat = this.flat ?? [], b = p.bounds, header = this.headerRect, height = this.treeHeight;
    // Rows are a flat list with no gap, so the pressed row's own rectangle places every row: its height is their
    // pitch and its index counts rows up to the first one. The header records its rectangle on any press outside
    // it; the tree reports its height. Together they are the tree's rectangle, in the panel's width below the header.
    const known = Boolean(b) && b.height > 0 && flat.length === p.total && flat[p.index]?.path === p.path;
    const tree = known && header && header.h > 0 && header.w > 0 && height > 0 && b.y >= header.y + header.h - 1
      ? { x: header.x, y: header.y + header.h, w: header.w, h: height } : null;
    const first = known ? b.y - p.index * b.height : 0;
    const inside = tree && b.x >= tree.x - 1 && b.x + b.width <= tree.x + tree.w + 1 && b.y + b.height <= tree.y + tree.h + 1;
    const folders = known ? flat.flatMap((r, i) => (r.dir ? [{ path: r.path, y: first + i * b.height }] : [])) : [];
    openOverlay({ mod: "mayonaka-files-drag", kind: "window", frame: "none", width: 1, height: 1, at: { x: 0, y: 0 },
      props: { panel: this.panelId, path: p.path, dir: p.dir, parent: parentOf(p.path), name: baseName(p.path), root: baseName(this.root ?? ""),
        icon: iconPath(p.dir ? folderIcon(baseName(p.path), false) : fileIcon(baseName(p.path))), x: e.position.x, y: e.position.y,
        ...(known ? { cols: { left: b.x, right: b.x + b.width }, rowH: b.height, first, last: first + flat.length * b.height, folders,
          header: inside ? header : null, tree: inside ? tree : null } : {}) } });
  }

  // No command types text into a terminal without Enter, so the path goes through the clipboard, which is then put back.
  drop(pane, path, cx) {
    const pasted = shellQuote(join(this.root, path)) + " ", before = cx.read_from_clipboard();
    cx.write_to_clipboard(pasted);
    run("pane.focus", { pane });
    run("terminal.paste");
    cx.timer.after(400, cx => { if (before !== undefined && cx.read_from_clipboard() === pasted) cx.write_to_clipboard(before); });
  }

  openMenu(path, dir) {
    const items = this.menuItems(path, dir);
    const height = 10 + items.length * 31 + items.filter(i => i.sep).length * 9;
    openOverlay({ mod: "mayonaka-files-menu", kind: "popup", width: 236, height,
      props: { stage: "menu", items, panel: this.panelId, path, dir, name: path ? baseName(path) : baseName(this.root ?? ""), root: baseName(this.root ?? ""), on: this.on } });
  }

  // Runs what the menu chose, or what a drop handed back. File work happens here, where the tree, its folders
  // and the editor link live.
  perform({ action, path, name, pane, to, dir }, cx) {
    const root = this.root, on = this.on, context = this.context, abs = join(root, path);
    const fail = (title, e) => notify({ title, body: String(e?.message ?? e), level: "error" });
    const platform = window()?.platform;
    switch (action) {
      case "open": return this.openFile(path, false);
      case "drop": return this.drop(pane, path, cx);
      case "refresh": return this.refresh(cx);
      case "copy-path":
      case "copy-relative":
        cx.write_to_clipboard(action === "copy-path" ? abs : path);
        notify({ title: "Copied", body: action === "copy-path" ? abs : path, level: "success", timeout: 2000 });
        return;
      case "open-default":
      case "reveal": {
        const args = platform === "macos" ? ["open", action === "reveal" ? ["-R", abs] : [abs]]
          : platform === "windows" ? (action === "reveal" ? ["explorer", [`/select,${abs.replace(/\//g, "\\")}`]] : ["cmd", ["/c", "start", "", abs]])
          : ["xdg-open", [action === "reveal" ? join(root, parentOf(path)) : abs]];
        // explorer.exe exits 1 even when it worked, so only a failure to start counts.
        exec(args[0], args[1]).catch(e => fail("Couldn't open", e));
        return;
      }
    }
    cx.spawn(async cx => {
      try {
        if (action === "new-file" || action === "new-folder") {
          const target = path ? `${path}/${name}` : name;
          await fsop(action, join(root, target), null, on);
          if (path && !this.folders.has(path) && this.current(context)) this.toggle(path, cx);
          if (action === "new-file" && this.current(context)) this.openFile(target, false);
        } else if (action === "rename") {
          const target = parentOf(path) ? `${parentOf(path)}/${name}` : name;
          await fsop("rename", abs, join(root, target), on);
          if (this.current(context)) for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
            this.folders.delete(folder); this.entries.delete(folder);
            this.folders.add(target + folder.slice(path.length));
          }
        } else if (action === "move") {
          // The overlay refuses these too; this is the second check, on the side that does the writing.
          if (to === parentOf(path) || (dir && (to === path || to.startsWith(path + "/")))) return;
          const dest = join(root, to ? `${to}/${baseName(path)}` : baseName(path));
          await fsop("move", abs, dest, on);
          if (!this.current(context)) return;
          for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
            this.folders.delete(folder); this.entries.delete(folder);
            this.folders.add((to ? `${to}/` : "") + baseName(path) + folder.slice(path.length));
          }
          // Every editor pane showing it, or a file under it, follows: mods/mayonaka-editor reads this.
          setShared("mayonaka-editor.moved", { from: abs, to: dest, on: on ?? null, n: Date.now() });
          // The folder that just took it opens, so the moved row is right there.
          if (to && !this.folders.has(to)) this.toggle(to, cx);
        } else if (action === "delete") {
          await fsop("delete", abs, null, on);
          if (this.current(context)) for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) { this.folders.delete(folder); this.entries.delete(folder); }
        } else return;
        if (this.current(context)) { this.loading = false; this.refresh(cx); }
      } catch (e) {
        fail(action === "delete" ? `Couldn't delete ${baseName(path)}` : action === "rename" ? `Couldn't rename ${baseName(path)}` : action === "move" ? `Couldn't move ${baseName(path)}` : `Couldn't create ${name}`, e);
      } finally { cx.notify(); }
    });
  }

  // Every row the tree draws, in order: rows are a flat 28px list, so a row's y is the first row's plus its index.
  flatRows() {
    const out = [], walk = (prefix, depth) => {
      if (out.length >= TOTAL || depth > 40) return;
      for (const entry of this.entries.get(prefix) ?? []) {
        if (out.length >= TOTAL) break;
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        out.push({ path, dir: entry.dir, depth, open: entry.dir && this.folders.has(path) });
        if (entry.dir && this.folders.has(path)) walk(path, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }

  rows(flat, t) {
    const opened = this.openedFile();
    return flat.map(({ path, dir, depth, open }, i) => {
      const mark = this.marks[`${this.root}/${path}`];
      return h_flex().id(`file-${path}`).h(ROW_H).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
        .when(!dir && opened === `${this.root}/${path}`, el => el.bg(t.selected))
        .on_click((e, cx) => dir ? this.toggle(path, cx) : this.openFile(path, e.modifiers.platform))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(path, dir); })
        .on_mouse_down("left", e => { this.press = { path, dir, x: e.position.x, y: e.position.y, index: i, total: flat.length, bounds: e.bounds }; })
        .on_mouse_move(e => this.dragFrom(e))
        .child(dir ? svg(`mods/mayonaka-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(image(iconPath(dir ? folderIcon(baseName(path), open) : fileIcon(baseName(path)))).w(16).h(16).flex_none())
        .child(div().flex_1().min_w(0).truncate().child(baseName(path)))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)));
    });
  }

  render(cx) {
    this.claimSplit();
    // While a row is being dragged the tree must not reload: the overlay finds folders by the rows it measured.
    const drag = shared(DRAG), live = drag?.panel === this.panelId && Date.now() - (drag.n ?? 0) < 60000;
    if (live) this.dragging = true;
    else if (this.dragging) { this.dragging = false; this.refresh(cx); }
    const f = focused(), fp = f?.pane && panes().find(p => p.pane === f.pane);
    if (fp?.mod === "mayonaka-editor") this.lastEditor = fp.pane;
    if (key() !== this.context?.key) this.refresh(cx);
    const action = shared(ACTION);
    if (action?.panel === this.panelId && action.n !== this.handled) { this.handled = action.n; this.perform(action, cx); }
    const t = theme(), flat = this.flat = this.flatRows();
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        // A drop here means the panel's own folder, so its rectangle is remembered for the drag overlay.
        .on_mouse_down_out(e => { this.headerRect = rectOf(e.bounds); })
        .when(Boolean(this.file), el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      .when(!this.file, el => el.child(v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scrollbar().p(6)
        // The drag overlay needs the tree's height; its width and top come from the header's rectangle.
        .on_size_change(size => { this.treeHeight = size.height; })
        .on_mouse_down("right", (_e, cx) => { if (this.root) { cx.stop_propagation(); this.openMenu("", true); } })
        // There is no "button still held" on a move, so a press that leaves the tree or comes up is forgotten.
        .on_mouse_up("left", () => { this.press = null; })
        .on_hover(hovered => { if (!hovered) this.press = null; })
        .children(this.rows(flat, t))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
