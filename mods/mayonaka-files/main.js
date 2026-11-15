// A lazy file browser and deep fuzzy file finder for the focused pane's folder.
// Files open as tabs in an editor pane beside the terminals (⌘-click or ⌘-Enter: a new split).
// Right-click opens mods/mayonaka-files-menu, which hands the chosen action back through shared("mayonaka-files.action").
// Dragging a row opens mods/mayonaka-files-drag; dropping it on a terminal pane types the path there, and dropping it
// on another folder row (or the header, or the tree's blank space) moves it there.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, Input, InputState, ScrollHandle } from "gpui-base";
import { fileIcon, folderIcon, iconPath } from "./material.js";
import {
  spaces, panes, focused, exec, readTextFile, watchFolder,
  theme, settings, window, run, shared, setShared, openOverlay, notify, nextCommand,
} from "herdr";

// mods/mayonaka-editor never learns its own pane id from props, so this panel and the editor map pane ids here.
const editorIds = () => shared("mayonaka-editor.ids") ?? {};

let last = null;
function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const allPanes = panes();
  const pane = f?.pane ? allPanes.find((p) => p.pane === f.pane) : null;
  if (pane?.mod) {
    if (last?.space === space?.id && last?.cwd) return last;
    const sibling = allPanes.find((p) => p.tab === f?.tab && !p.mod && p.cwd);
    const edId = editorIds()[pane.pane];
    const edRoot = edId ? (shared("mayonaka-editor.files") ?? {})[edId]?.root : null;
    const on = space?.machine ?? null;
    const cwd = sibling?.cwd || edRoot || space?.folder;
    return (last = { cwd, on, space: space?.id });
  }
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return (last = { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id });
}

const key = () => JSON.stringify(location());
const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000, MAX_INDEX = 25000, MAX_RESULTS = 100;
const ACTION = "mayonaka-files.action", DRAG = "mayonaka-files.drag", SEARCH_REQ = "mayonaka-files.search";
// Rows are a flat list of one height with no gap: a drag places every folder row from the pressed row's rectangle.
const ROW_H = 28;

const join = (root, path) => (path ? `${root}/${path}` : root);
const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseName = (path) => path.split(/[\\/]/).pop();
const shellQuote = (path) => (/^[\w@%+=:,./~-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`);
const rectOf = (b) => (b ? { x: b.x, y: b.y, w: b.width, h: b.height } : null);
const isJunkName = (name) => name === ".git" || name === ".DS_Store" || name === "Thumbs.db" || name === "desktop.ini" || name.startsWith("._");

function editorTabsOf(entry) {
  if (Array.isArray(entry?.tabs)) return entry.tabs;
  return entry?.file ? [{ id: "t0", file: entry.file, on: entry.on ?? null, dirty: Boolean(entry.dirty) }] : [];
}

function fuzzy(q, text) {
  const lower = text.toLowerCase();
  let score = 0, at = 0, runLen = 0;
  const hits = [];
  for (const ch of q) {
    const i = lower.indexOf(ch, at);
    if (i < 0) return null;
    const start = i === 0 || /[\s:.\-_/]/.test(lower[i - 1]);
    runLen = i === at && hits.length ? runLen + 1 : 0;
    score += 1 + (start ? 6 : 0) + runLen * 3.5 - Math.min(i - at, 6) * 0.25;
    hits.push(i);
    at = i + 1;
  }
  return { score: score - text.length * 0.02, hits };
}

function hasCharsInOrder(q, lower) {
  let at = 0;
  for (let i = 0; i < q.length; i++) {
    at = lower.indexOf(q[i], at);
    if (at < 0) return false;
    at++;
  }
  return true;
}

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
  const mv = 'if [ -e "$2" ] || [ -L "$2" ]; then echo "${2##*/} already exists" >&2; exit 1; fi; mv -- "$1" "$2"';
  const sh = {
    "new-file": exists + ': > "$1"',
    "new-folder": exists + 'mkdir -- "$1"',
    rename: mv,
    move: mv,
    delete: on || window()?.platform !== "macos" ? 'rm -rf -- "$1"' : 'if command -v trash >/dev/null 2>&1; then trash "$1"; else osascript -e \'on run argv\' -e \'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)\' -e \'end run\' "$1" >/dev/null; fi',
  }[kind];
  const r = await exec("sh", ["-c", sh, "files", a, ...(b ? [b] : [])], { on });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Failed");
}

async function directory(path, on) {
  const windowsDirectory = async () => {
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

async function listAllFiles(root, on, useGit, marks) {
  if (useGit) {
    const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, on }).catch(() => null);
    if (r?.code === 0) {
      const seen = new Set(), out = [];
      for (const raw of r.stdout.split("\0")) {
        if (!raw || seen.has(raw)) continue;
        const name = baseName(raw);
        if (isJunkName(name)) continue;
        if (marks[`${root}/${raw}`] === "D") continue;
        seen.add(raw);
        out.push({ path: raw, name, dir: parentOf(raw), lower: raw.toLowerCase() });
        if (out.length >= MAX_INDEX) break;
      }
      return { items: out, capped: out.length >= MAX_INDEX };
    }
  }

  const windowsScan = async () => {
    const ps = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($root)
      $skip = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
      @('.git','node_modules','.venv','target','__pycache__','.next','Library','.Trash') | ForEach-Object { [void]$skip.Add($_) }
      $q = [System.Collections.Generic.Queue[string]]::new()
      $q.Enqueue($root)
      $n = 0
      while ($q.Count -gt 0 -and $n -lt ${MAX_INDEX}) {
        $d = $q.Dequeue()
        foreach ($e in Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue) {
          if ($e.Name -in @('.DS_Store','Thumbs.db','desktop.ini') -or $e.Name -like '._*') { continue }
          if ($e.PSIsContainer) {
            if (-not $skip.Contains($e.Name) -and -not ($e.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $q.Enqueue($e.FullName) }
          } else {
            $rel = $e.FullName.Substring($root.Length).TrimStart('\\','/') -replace '\\\\','/'
            Write-Output $rel
            $n++
            if ($n -ge ${MAX_INDEX}) { break }
          }
        }
      }
    } '${root.replace(/['‘’‚‛]/g, "$&$&")}'`;
    const r = await exec("powershell", ["-NoProfile", "-Command", ps], { on });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Cannot index folder");
    return r.stdout.split(/\r?\n/);
  };

  let lines;
  if (!on && window()?.platform === "windows") {
    lines = await windowsScan();
  } else {
    const sh = `if command -v rg >/dev/null 2>&1; then
      rg --files --hidden --no-ignore -g '!.git' -g '!node_modules' -g '!.venv' -g '!target' -g '!__pycache__' -g '!.next' -g '!Library' -g '!.Trash' 2>/dev/null | head -n ${MAX_INDEX}
    else
      find . \\( -name .git -o -name node_modules -o -name .venv -o -name target -o -name __pycache__ -o -name .next -o -name Library -o -name .Trash \\) -prune -o \\( -type f -o -type l \\) -print 2>/dev/null | sed 's|^\\./||' | head -n ${MAX_INDEX}
    fi`;
    try {
      const r = await exec("sh", ["-c", sh], { cwd: root, on });
      lines = r.stdout.split("\n");
    } catch (e) {
      if (on && String(e).includes("cannot start sh: program not found")) lines = await windowsScan();
      else throw e;
    }
  }
  const seen = new Set(), out = [];
  for (const raw of lines) {
    const clean = raw.replace(/^\.\//, "").trim();
    if (!clean || seen.has(clean)) continue;
    const name = baseName(clean);
    if (isJunkName(name)) continue;
    seen.add(clean);
    out.push({ path: clean, name, dir: parentOf(clean), lower: clean.toLowerCase() });
    if (out.length >= MAX_INDEX) break;
  }
  return { items: out, capped: out.length >= MAX_INDEX };
}

export default class Files extends View {
  init(_props, cx) {
    this.saved = new Map();
    this.panelId = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {}; this.ignored = new Set();
    this.handle = cx.focus_handle();
    this.treeScroll = ScrollHandle.new();
    this.searchScroll = ScrollHandle.new();
    this.cursor = -1;
    this.cmdHeld = false;

    this.searching = false;
    this.query = "";
    this.searchAt = 0;
    this.searchIgnored = false;
    this.indexCache = null;
    this.indexing = false;
    this.searchSeen = shared(SEARCH_REQ)?.n ?? 0;

    this.searchInput = InputState.new({ placeholder: "Filter files…" });
    this.searchInput.on("change", (_e, cx) => {
      this.query = this.searchInput.value();
      this.searchAt = 0;
      this.searchScroll.scroll_to_item(0);
      cx.notify();
    });
    this.searchInput.on("submit", (ev, cx) => {
      const hit = this.filteredResults()[this.searchAt];
      if (hit) this.openFile(hit.path, Boolean(ev?.secondary || this.cmdHeld));
    });

    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") {
          if (this.searching) this.searchInput.focus();
          else this.handle.focus();
          cx.notify();
        } else if (c === "search") {
          this.startSearch("", cx);
        }
      }
    });
  }

  async close() {
    this.searchInput?.release();
    this.treeScroll?.release();
    this.searchScroll?.release();
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async (cx) => {
      try {
        while (this.context === context) {
          await watchFolder(root);
          if (this.current(context)) {
            this.indexCache = null;
            this.refresh(cx);
          }
        }
      } catch {
        if (this.context === context) this.watched = null;
      }
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
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on;
      this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.ignored = new Set(); this.repo = null;
      this.indexCache = null; this.indexing = false; this.cursor = -1;
      this.show(null); this.watched = null; this.error = null; this.limited = false;
      this.loading = false;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {}, ignored = new Set(), repo = top?.code === 0 ? top.stdout.trim() : null;
        if (repo) {
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignored=matching"], { cwd, on }).catch(() => null);
          if (status?.code === 0) {
            let n = 0;
            for (const entry of status.stdout.split("\0")) {
              if (!entry) continue;
              const xy = entry.slice(0, 2), file = `${repo}/${entry.slice(3)}`;
              if (xy === "!!") ignored.add(file.replace(/\/$/, ""));
              else if (n++ < TOTAL) marks[file] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
            }
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.ignored = ignored; this.repo = repo; this.error = null;
        this.watch(cwd, cx);
        if (this.searching && !this.indexCache) this.ensureSearchIndex(cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  startSearch(seed = "", cx) {
    if (!this.root) return;
    const alreadyOpen = this.searching;
    this.searching = true;
    this.searchAt = 0;
    if (seed) {
      this.query = seed;
      this.searchInput.set_value(seed);
      this.searchInput.set_selected_range({ start: seed.length, end: seed.length });
    } else if (alreadyOpen && this.query) {
      this.searchInput.set_selected_range({ start: 0, end: this.query.length });
    }
    this.ensureSearchIndex(cx);
    this.searchInput.focus();
    cx.spawn(async (cx) => {
      await cx.sleep(0);
      if (this.searching) this.searchInput.focus();
      cx.notify();
    });
    cx.notify();
  }

  closeSearch(cx, focusTree = true) {
    if (!this.searching) return;
    this.searching = false;
    this.query = "";
    this.searchAt = 0;
    this.searchInput.set_value("");
    if (focusTree) this.handle.focus();
    cx.notify();
  }

  ensureSearchIndex(cx) {
    if (!this.root || this.indexing) return;
    const useGit = Boolean(this.repo && !this.searchIgnored);
    const cacheKey = `${this.context?.key}::${useGit ? "git" : "all"}`;
    if (this.indexCache?.key === cacheKey) return;
    const context = this.context, root = this.root, on = this.on, marks = this.marks;
    this.indexing = true;
    cx.spawn(async (cx) => {
      try {
        const res = await listAllFiles(root, on, useGit, marks);
        if (!this.current(context)) return;
        this.indexCache = { key: cacheKey, items: res.items, capped: res.capped };
      } catch {
        if (this.current(context)) this.indexCache = { key: cacheKey, items: [], capped: false };
      } finally {
        if (this.context === context) this.indexing = false;
        cx.notify();
      }
    });
  }

  filteredResults() {
    const items = this.indexCache?.items ?? [];
    const q = this.query.trim().toLowerCase().replace(/\s+/g, "");
    const { openSet } = this.openState();
    if (!q) {
      const opened = [], rest = [];
      for (const it of items) {
        if (openSet.has(`${this.root}/${it.path}`)) opened.push({ ...it, hits: [] });
        else if (opened.length + rest.length < MAX_RESULTS) rest.push({ ...it, hits: [] });
      }
      return [...opened, ...rest].slice(0, MAX_RESULTS);
    }
    const scored = [];
    for (const it of items) {
      if (!hasCharsInOrder(q, it.lower)) continue;
      const byName = fuzzy(q, it.name);
      const byPath = byName ? null : fuzzy(q, it.path);
      if (!byName && !byPath) continue;
      const prefixLen = it.dir ? it.dir.length + 1 : 0;
      const hits = byName
        ? byName.hits
        : byPath.hits.filter((h) => h >= prefixLen).map((h) => h - prefixLen);
      const openBonus = openSet.has(`${this.root}/${it.path}`) ? 2.5 : 0;
      const score = (byName ? byName.score + 24 : byPath.score) + openBonus - it.path.length * 0.03;
      scored.push({ ...it, score, hits });
    }
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
    return scored.slice(0, MAX_RESULTS);
  }

  revealInTree(path, cx) {
    this.closeSearch(cx, true);
    const parts = path.split("/");
    const ancestors = [];
    for (let i = 1; i < parts.length; i++) ancestors.push(parts.slice(0, i).join("/"));
    const context = this.context;
    cx.spawn(async (cx) => {
      for (const folder of ancestors) {
        this.folders.add(folder);
        if (!this.entries.has(folder)) {
          try { await this.loadFolder(folder, context); } catch { /* ignore */ }
        }
      }
      if (!this.current(context)) return;
      const flat = this.flatRows();
      const idx = flat.findIndex((r) => r.path === path);
      if (idx >= 0) {
        this.cursor = idx;
        this.treeScroll.scroll_to_item(idx);
      }
      this.handle.focus();
      cx.notify();
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
        cx.spawn(async (cx) => {
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
    const ids = editorIds(), fresh = panes().find((p) => p.mod === "mayonaka-editor" && !ids[p.pane]);
    if (!fresh) return;
    setShared("mayonaka-editor.ids", { ...ids, [fresh.pane]: this.pendingId });
    this.lastEditor = fresh.pane; this.pendingId = null;
  }

  openFile(path, split) {
    const file = `${this.root}/${path}`, on = this.on ?? null, root = this.root, f = focused(), ids = editorIds();
    const filesMap = shared("mayonaka-editor.files") ?? {};
    const editors = panes().filter((p) => p.mod === "mayonaka-editor" && p.tab === f?.tab && ids[p.pane]);
    if (!split) {
      // First check whether any editor pane in this workspace tab already holds this file so we focus its tab instead of duplicating.
      const existingPane = editors.find((p) =>
        editorTabsOf(filesMap[ids[p.pane]]).some((t) => t.file === file && (t.on ?? null) === on),
      );
      const target = existingPane
        ?? editors.find((p) => p.focused)
        ?? editors.find((p) => p.pane === this.lastEditor)
        ?? editors[editors.length - 1];
      if (target) {
        setShared("mayonaka-editor.open", { id: ids[target.pane], file, on, root, n: Date.now() });
        this.lastEditor = target.pane;
        run("pane.focus", { pane: target.pane });
        return;
      }
    }
    const target = editors.find((p) => p.focused) ?? editors.find((p) => p.pane === this.lastEditor) ?? editors[editors.length - 1];
    const id = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.pendingId = id;
    run("pane.split", { direction: "right", ...(target ? { pane: target.pane } : {}), mod: "mayonaka-editor", props: { id, file, on, root } });
    this.claimSplit();
  }

  openState() {
    const f = focused(), allPanes = panes(), ids = editorIds(), filesMap = shared("mayonaka-editor.files") ?? {};
    const editors = allPanes.filter((p) => p.mod === "mayonaka-editor" && p.tab === f?.tab && ids[p.pane]);
    const fp = f?.pane && allPanes.find((p) => p.pane === f.pane);
    const activePane = fp?.mod === "mayonaka-editor" ? fp.pane : this.lastEditor;
    const activeId = activePane ? ids[activePane] : null;
    const activeFile = activeId ? filesMap[activeId]?.file ?? null : null;
    const openSet = new Map();
    const curOn = this.on ?? null;
    for (const p of editors) {
      for (const tab of editorTabsOf(filesMap[ids[p.pane]])) {
        if (tab?.file && (tab.on ?? null) === curOn) {
          openSet.set(tab.file, { dirty: Boolean(tab.dirty) });
        }
      }
    }
    return { activeFile, openSet };
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async (cx) => {
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

  menuItems(path, dir, fromSearch = false) {
    const local = !this.on, root = !path, platform = window()?.platform, items = [];
    const add = (label, action, icon, sep = false, danger = false) => items.push({ label, action, icon, sep: sep && items.length > 0, danger });
    if (dir) {
      add("New File…", "new-file", "plus");
      add("New Folder…", "new-folder", "folder-plus");
    } else {
      add("Open", "open", "file-text");
      add("Open to the Side", "open-split", "mods/mayonaka-pane/split-right.svg");
      if (fromSearch) add("Reveal in Tree", "reveal-tree", "folder");
    }
    if (local && !dir) add("Open with Default App", "open-default", "external-link", true);
    if (local) add(platform === "macos" ? "Reveal in Finder" : platform === "windows" ? "Show in Explorer" : "Open Containing Folder", "reveal", "folder", dir);
    add("Copy Path", "copy-path", "copy", true);
    if (!root) add("Copy Relative Path", "copy-relative", "copy");
    if (root) add("Refresh", "refresh", "refresh", true);
    else { add("Rename…", "rename", "square-pen", true); add("Delete", "delete", "trash", false, true); }
    return items;
  }

  dragFrom(e, allowTreeMove = true) {
    const p = this.press;
    if (!p || Math.hypot(e.position.x - p.x, e.position.y - p.y) < 6) return;
    this.press = null;
    this.dragging = true;
    setShared(DRAG, { panel: this.panelId, n: Date.now() });
    const flat = this.flat ?? [], b = p.bounds, header = this.headerRect, height = this.treeHeight;
    const known = allowTreeMove && Boolean(b) && b.height > 0 && flat.length === p.total && flat[p.index]?.path === p.path;
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
    cx.timer.after(400, (cx) => { if (before !== undefined && cx.read_from_clipboard() === pasted) cx.write_to_clipboard(before); });
  }

  openMenu(path, dir, fromSearch = false) {
    const items = this.menuItems(path, dir, fromSearch);
    const height = 10 + items.length * 31 + items.filter((i) => i.sep).length * 9;
    openOverlay({ mod: "mayonaka-files-menu", kind: "popup", width: 236, height,
      props: { stage: "menu", items, panel: this.panelId, path, dir, name: path ? baseName(path) : baseName(this.root ?? ""), root: baseName(this.root ?? ""), on: this.on } });
  }

  perform({ action, path, name, pane, to, dir }, cx) {
    const root = this.root, on = this.on, context = this.context, abs = join(root, path);
    const fail = (title, e) => notify({ title, body: String(e?.message ?? e), level: "error" });
    const platform = window()?.platform;
    switch (action) {
      case "open": return this.openFile(path, false);
      case "open-split": return this.openFile(path, true);
      case "reveal-tree": return this.revealInTree(path, cx);
      case "drop": return this.drop(pane, path, cx);
      case "refresh": this.indexCache = null; return this.refresh(cx);
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
        exec(args[0], args[1]).catch((e) => fail("Couldn't open", e));
        return;
      }
    }
    cx.spawn(async (cx) => {
      try {
        if (action === "new-file" || action === "new-folder") {
          const target = path ? `${path}/${name}` : name;
          await fsop(action, join(root, target), null, on);
          if (path && !this.folders.has(path) && this.current(context)) this.toggle(path, cx);
          if (action === "new-file" && this.current(context)) this.openFile(target, false);
        } else if (action === "rename") {
          const target = parentOf(path) ? `${parentOf(path)}/${name}` : name;
          const dest = join(root, target);
          await fsop("rename", abs, dest, on);
          if (this.current(context)) {
            for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
              this.folders.delete(folder); this.entries.delete(folder);
              this.folders.add(target + folder.slice(path.length));
            }
            setShared("mayonaka-editor.moved", { from: abs, to: dest, on: on ?? null, n: Date.now() });
          }
        } else if (action === "move") {
          if (to === parentOf(path) || (dir && (to === path || to.startsWith(path + "/")))) return;
          const dest = join(root, to ? `${to}/${baseName(path)}` : baseName(path));
          await fsop("move", abs, dest, on);
          if (!this.current(context)) return;
          for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
            this.folders.delete(folder); this.entries.delete(folder);
            this.folders.add((to ? `${to}/` : "") + baseName(path) + folder.slice(path.length));
          }
          setShared("mayonaka-editor.moved", { from: abs, to: dest, on: on ?? null, n: Date.now() });
          if (to && !this.folders.has(to)) this.toggle(to, cx);
        } else if (action === "delete") {
          await fsop("delete", abs, null, on);
          if (this.current(context)) {
            for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
              this.folders.delete(folder); this.entries.delete(folder);
            }
            setShared("mayonaka-editor.deleted", { path: abs, dir: Boolean(dir), on: on ?? null, n: Date.now() });
          }
        } else return;
        this.indexCache = null;
        if (this.current(context)) { this.loading = false; this.refresh(cx); }
      } catch (e) {
        fail(action === "delete" ? `Couldn't delete ${baseName(path)}` : action === "rename" ? `Couldn't rename ${baseName(path)}` : action === "move" ? `Couldn't move ${baseName(path)}` : `Couldn't create ${name}`, e);
      } finally { cx.notify(); }
    });
  }

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

  isIgnored(file) {
    if (!this.repo || !this.ignored.size) return false;
    for (let p = file; p.length > this.repo.length; p = p.slice(0, p.lastIndexOf("/"))) if (this.ignored.has(p)) return true;
    return false;
  }

  highlightedName(t, text, hits, gone) {
    if (!hits?.length) return div().truncate().when(gone, (el) => el.text_color(t.dim)).child(text);
    const hitSet = new Set(hits), parts = [];
    let cur = "", lit = false;
    [...text].forEach((ch, i) => {
      const h = hitSet.has(i);
      if (h !== lit && cur) { parts.push([cur, lit]); cur = ""; }
      lit = h;
      cur += ch;
    });
    if (cur) parts.push([cur, lit]);
    return h_flex().min_w(0).overflow_hidden().children(parts.map(([s, h]) =>
      div().flex_none().text_color(h ? t.accent : gone ? t.dim : t.foreground).when(h, (d) => d.font_semibold()).child(s.replace(/ /g, "\u00a0")),
    ));
  }

  rows(flat, t, state) {
    const { activeFile, openSet } = state;
    return flat.map(({ path, dir, depth, open }, i) => {
      const abs = `${this.root}/${path}`;
      const mark = this.marks[abs], gone = this.isIgnored(abs);
      const isActive = !dir && activeFile === abs;
      const openInfo = !dir ? openSet.get(abs) : null;
      const selected = isActive || i === this.cursor;
      return h_flex().id(`file-${path}`).h(ROW_H).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
        .when(selected, (el) => el.bg(t.selected))
        .on_click((e, cx) => {
          this.cursor = i;
          if (dir) this.toggle(path, cx);
          else this.openFile(path, e.modifiers.platform);
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(path, dir, false); })
        .on_mouse_down("left", (e) => { this.press = { path, dir, x: e.position.x, y: e.position.y, index: i, total: flat.length, bounds: e.bounds }; })
        .on_mouse_move((e) => this.dragFrom(e, true))
        .child(dir ? svg(`mods/mayonaka-files/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child(image(iconPath(dir ? folderIcon(baseName(path), open) : fileIcon(baseName(path)))).w(16).h(16).flex_none().when(gone, (el) => el.opacity(0.45)))
        .child(div().flex_1().min_w(0).truncate().when(gone, (el) => el.text_color(t.dim)).child(baseName(path)))
        .when(Boolean(openInfo) && !isActive, (el) => el.child(div().size(5).flex_none().rounded(3).bg(openInfo.dirty ? t.accent : t.muted)))
        .when(Boolean(mark), (el) => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.ansi3).child(mark)));
    });
  }

  searchRows(results, t, state) {
    const { activeFile, openSet } = state;
    return results.map((item, i) => {
      const { path, name, dir, hits } = item;
      const abs = `${this.root}/${path}`;
      const mark = this.marks[abs], gone = this.isIgnored(abs);
      const openInfo = openSet.get(abs);
      const selected = i === this.searchAt;
      return h_flex().id(`sfile-${path}`).h(ROW_H).flex_none().px(8).gap(7).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
        .when(selected, (el) => el.bg(t.selected))
        .tooltip(path)
        .on_click((e, cx) => {
          this.searchAt = i;
          this.openFile(path, e.modifiers.platform);
          cx.notify();
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.openMenu(path, false, true); })
        .on_mouse_down("left", (e) => { this.press = { path, dir: false, x: e.position.x, y: e.position.y, index: i, total: results.length, bounds: e.bounds }; })
        .on_mouse_move((e) => this.dragFrom(e, false))
        .child(image(iconPath(fileIcon(name))).w(16).h(16).flex_none().when(gone, (el) => el.opacity(0.45)))
        .child(
          h_flex().flex_1().min_w(0).gap(6).items_center()
            .child(div().flex_none().max_w(190).overflow_hidden().child(this.highlightedName(t, name, hits, gone)))
            .when(Boolean(dir), (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(dir))),
        )
        .when(Boolean(openInfo), (el) => el.child(div().size(5).flex_none().rounded(3).bg(openInfo.dirty || activeFile === abs ? t.accent : t.muted)))
        .when(Boolean(mark), (el) => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.ansi3).child(mark)));
    });
  }

  onKeyDown(e, flat, results, cx) {
    this.cmdHeld = Boolean(e.modifiers.platform);
    if (this.searching) {
      const k = e.key;
      if (k === "escape") {
        cx.stop_propagation();
        this.closeSearch(cx, true);
        return;
      }
      if (k === "down" || (e.modifiers.control && k === "n")) {
        if (results.length) {
          this.searchAt = Math.min(this.searchAt + 1, results.length - 1);
          this.searchScroll.scroll_to_item(this.searchAt);
        }
        cx.stop_propagation();
        cx.notify();
        return;
      }
      if (k === "up" || (e.modifiers.control && k === "p")) {
        if (results.length) {
          this.searchAt = Math.max(this.searchAt - 1, 0);
          this.searchScroll.scroll_to_item(this.searchAt);
        }
        cx.stop_propagation();
        cx.notify();
        return;
      }
      if (e.modifiers.platform && k === "f") {
        cx.stop_propagation();
        this.startSearch("", cx);
      }
      return;
    }

    // Tree mode keyboard navigation & speed search
    const k = e.key;
    if (k === "/" || (e.modifiers.platform && k === "f")) {
      cx.stop_propagation();
      this.startSearch("", cx);
      return;
    }
    if (!e.modifiers.platform && !e.modifiers.control && !e.modifiers.alt && e.key_char && e.key_char.length === 1 && k !== " " && k !== "enter" && k !== "escape" && k !== "tab") {
      cx.stop_propagation();
      this.startSearch(e.key_char, cx);
      return;
    }
    if (!flat.length) return;
    if (k === "down") {
      this.cursor = Math.min((this.cursor < 0 ? -1 : this.cursor) + 1, flat.length - 1);
      this.treeScroll.scroll_to_item(this.cursor);
      cx.stop_propagation(); cx.notify();
    } else if (k === "up") {
      this.cursor = Math.max((this.cursor <= 0 ? 0 : this.cursor - 1), 0);
      this.treeScroll.scroll_to_item(this.cursor);
      cx.stop_propagation(); cx.notify();
    } else if (k === "right" && this.cursor >= 0 && flat[this.cursor]?.dir) {
      const row = flat[this.cursor];
      if (!row.open) this.toggle(row.path, cx);
      cx.stop_propagation();
    } else if (k === "left" && this.cursor >= 0) {
      const row = flat[this.cursor];
      if (row?.dir && row.open) this.toggle(row.path, cx);
      else if (row) {
        const parent = parentOf(row.path);
        const pIdx = parent ? flat.findIndex((r) => r.path === parent) : -1;
        if (pIdx >= 0) { this.cursor = pIdx; this.treeScroll.scroll_to_item(pIdx); cx.notify(); }
      }
      cx.stop_propagation();
    } else if (k === "enter" && this.cursor >= 0 && flat[this.cursor]) {
      const row = flat[this.cursor];
      if (row.dir) this.toggle(row.path, cx);
      else this.openFile(row.path, e.modifiers.platform);
      cx.stop_propagation();
    } else if (k === "escape" && this.cursor >= 0) {
      this.cursor = -1;
      cx.stop_propagation(); cx.notify();
    }
  }

  renderHeader(t, cx) {
    const stop = (_e, cx) => cx.stop_propagation();
    if (this.searching) {
      return h_flex().h(42).flex_none().px(10).gap(6).items_center().border_b(1).border_color(t.border)
        .on_mouse_down_out((e) => { this.headerRect = rectOf(e.bounds); })
        .child(
          h_flex().flex_1().min_w(0).h(30).px(8).gap(6).items_center().rounded(7).border_1().border_color(t.accent).bg(t.canvas)
            .on_mouse_down("left", stop)
            .child(svg("mods/mayonaka-files/search.svg").size(14).flex_none().text_color(t.dim))
            .child(Input.new(this.searchInput).flex_1().h_full().items_center().text_size(12.5).text_color(t.foreground))
            .when(Boolean(this.repo), (el) => el.child(
              div().id("files-search-ignored").px(5).py(1).rounded(4).cursor_pointer().text_size(10.5)
                .bg(this.searchIgnored ? t.selected : t.surface)
                .text_color(this.searchIgnored ? t.foreground : t.dim)
                .hover((s) => s.text_color(t.foreground))
                .tooltip(this.searchIgnored ? "Hiding nothing · click to exclude git-ignored files" : "Include git-ignored files")
                .on_mouse_down("left", stop)
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.searchIgnored = !this.searchIgnored;
                  this.indexCache = null;
                  this.searchAt = 0;
                  this.ensureSearchIndex(cx);
                  this.searchInput.focus();
                  cx.notify();
                })
                .child(".*"),
            ))
            .child(
              div().id("files-search-close").p(3).rounded(4).cursor_pointer().text_color(t.dim)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .tooltip("Close search (Esc)")
                .on_mouse_down("left", stop)
                .on_click((_e, cx) => { cx.stop_propagation(); this.closeSearch(cx, true); })
                .child(svg("mods/pane/close.svg").size(12)),
            ),
        );
    }

    return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
      // A drop here means the panel's own folder, so its rectangle is remembered for the drag overlay.
      .on_mouse_down_out((e) => { this.headerRect = rectOf(e.bounds); })
      .when(Boolean(this.file), (el) => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
      .child(div().font_semibold().child("Files"))
      .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? ""))
      .when(Boolean(this.root) && !this.file, (el) => el.child(
        div().id("files-search-btn").p(4).rounded(6).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Search files (⌘⌥F or /)")
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { cx.stop_propagation(); this.startSearch("", cx); })
          .child(svg("mods/mayonaka-files/search.svg").size(14)),
      ));
  }

  render(cx) {
    this.claimSplit();
    const drag = shared(DRAG), live = drag?.panel === this.panelId && Date.now() - (drag.n ?? 0) < 60000;
    if (live) this.dragging = true;
    else if (this.dragging) { this.dragging = false; this.refresh(cx); }
    const f = focused(), fp = f?.pane && panes().find((p) => p.pane === f.pane);
    if (fp?.mod === "mayonaka-editor") this.lastEditor = fp.pane;
    if (key() !== this.context?.key) this.refresh(cx);

    const searchReq = shared(SEARCH_REQ);
    if (searchReq && searchReq.n > this.searchSeen) {
      this.searchSeen = searchReq.n;
      this.startSearch("", cx);
    }

    const action = shared(ACTION);
    if (action?.panel === this.panelId && action.n !== this.handled) { this.handled = action.n; this.perform(action, cx); }

    const t = theme(), flat = (this.flat = this.flatRows());
    if (this.searching) this.ensureSearchIndex(cx);
    const results = this.searching ? this.filteredResults() : [];
    if (this.searching) this.searchAt = Math.min(this.searchAt, Math.max(0, results.length - 1));
    const state = this.openState();

    return v_flex().id("files").track_focus(this.handle).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .on_modifiers_changed((e) => { this.cmdHeld = Boolean(e.modifiers.platform); })
      .on_key_down((e, cx) => this.onKeyDown(e, flat, results, cx))
      .child(this.renderHeader(t, cx))
      .when(!this.file && this.searching, (el) => el.child(
        v_flex().id("files-search-list").flex_1().min_h(0).overflow_y_scroll().track_scroll(this.searchScroll).p(6)
          .on_mouse_up("left", () => { this.press = null; })
          .on_hover((hovered) => { if (!hovered) this.press = null; })
          .children(this.searchRows(results, t, state))
          .when(!results.length, (e2) => e2.child(
            div().p(10).text_size(12).text_color(t.dim).child(
              this.indexing && !this.indexCache
                ? "Indexing files…"
                : this.query
                  ? `No files match "${this.query}"${this.repo && !this.searchIgnored ? " · click .* to include ignored files" : ""}`
                  : "No files",
            ),
          ))
          .when(Boolean(this.indexCache?.capped), (e2) => e2.child(
            div().p(8).text_size(11).text_color(t.dim).child("Search index capped at 25,000 files"),
          )),
      ))
      .when(!this.file && !this.searching, (el) => el.child(
        v_flex().id("files-tree").flex_1().min_h(0).overflow_y_scroll().track_scroll(this.treeScroll).p(6)
          .on_size_change((size) => { this.treeHeight = size.height; })
          .on_mouse_down("right", (_e, cx) => { if (this.root) { cx.stop_propagation(); this.openMenu("", true, false); } })
          .on_mouse_up("left", () => { this.press = null; })
          .on_hover((hovered) => { if (!hovered) this.press = null; })
          .children(this.rows(flat, t, state))
          .when(Boolean(this.error) || !this.entries.get("")?.length, (e2) => e2.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
          .when(this.limited, (e2) => e2.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))),
      ))
      .when(Boolean(this.file), (el) => el.child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
