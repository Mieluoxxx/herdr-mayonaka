// A multi-tab file editor pane, opened beside the terminals by mayonaka-files:
//   pane.split {mod: "mayonaka-editor", props: {id, file, on, root}}
// Clicking files in mayonaka-files adds or activates tabs in this pane through shared("mayonaka-editor.open")
// instead of replacing open files; ⌘-click splits another editor pane beside it.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Textarea, TextareaState, ScrollHandle } from "gpui-base";
import { splitBlocks, refDefs, replaceBlock, appendBlock, itemMarkdown, itemNumbers } from "./blocks.js";
import { tokenize, blockMode, diff, continueLine, parseMarker, toggleTask } from "./inline.js";
import { imageSize, formatBytes } from "./image.js";
import { fileIcon, iconPath } from "./material.js";
import { BinaryFileError, readEditorFile, writeEditorText } from "./remote.js";
import {
  props, shared, setShared, watchFolder, exec, notify, nextCommand,
  theme, settings, appHome, panes, focused, layout, run, openOverlay, window as win,
} from "herdr";
import { readFile, writeFile, readdir, mkdir, unlink } from "fs/promises";
import { createHash } from "crypto";
import { Buffer } from "buffer";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", cjs: "js", toml: "yaml", yml: "yaml", jsonc: "json", svelte: "html", vue: "html", md: "markdown", markdown: "markdown", py: "python", rs: "rust", sh: "bash", zsh: "bash" };
// The file saves itself after the last edit (500 ms up to 256 KiB, 1.5 s up to 2 MiB, 3 s past that).
// The palette switches auto save through the shared key: on unless false.
const AUTOSAVE_SMALL_MS = 500;
const AUTOSAVE_MEDIUM_MS = 1500;
const AUTOSAVE_LARGE_MS = 3000;
const DIRTY_CHECK_MS = 800;
const DISCARD_WINDOW_MS = 5000;
const AUTOSAVE = "mayonaka-editor.autosave";
const MENU_KEY = "mayonaka-editor.menu";
const LARGE_MD = 256 * 1024;
const FOLD_MAX = 512 * 1024;
const MEDIUM_MAX = 2 * 1024 * 1024;
const LONG_LINE = 10000;
const MAX_CLEAN_TABS = 24;
const MAX_CLEAN_BYTES = 32 * 1024 * 1024;
const MIN_KEEP_CLEAN = 6;
const MAX_CLOSED_HISTORY = 10;
const HEADING = { 1: 30, 2: 23, 3: 19, 4: 17, 5: 15, 6: 14 };
const isMarkdown = (f) => /\.(md|markdown|mdx)$/i.test(f ?? "");
const isSvg = (f) => /\.svg$/i.test(f ?? "");
const isImage = (f) => /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|svg)$/i.test(f ?? "");
const hasPreview = (f) => isMarkdown(f) || isSvg(f);
// image() only loads files under the app's folder (not absolute paths, not symlinks out of it), so images are copied here.
const CACHE = "cache/mayonaka-editor";
const MAX_IMAGE = 32 * 1024 * 1024;
// exec output is capped at 8 MiB and base64 grows by a third.
const MAX_REMOTE_IMAGE = 6 * 1024 * 1024;
const dirname = (f) => f.slice(0, f.lastIndexOf("/")) || "/";
const baseName = (f) => (f ?? "").split("/").pop() || f || "";

function resolve(base, rel) {
  const parts = (rel.startsWith("/") ? rel : `${dirname(base)}/${rel}`).split("/"), out = [];
  for (const p of parts) { if (p === "..") out.pop(); else if (p && p !== ".") out.push(p); }
  return "/" + out.join("/");
}

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

function usesMayonakaPane() {
  return findNode(layout(), "main")?.content?.pane?.header?.content?.mod === "mayonaka-pane";
}

function relPathOf(tab) {
  if (!tab?.file) return "";
  if (tab.root && tab.file.startsWith(tab.root + "/")) return tab.file.slice(tab.root.length + 1);
  return tab.file;
}

// Disambiguates tabs that share the same basename by showing the shortest distinguishing parent suffix.
function tabLabels(tabs) {
  const byBase = new Map();
  for (const t of tabs) {
    const b = baseName(t.file);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(t);
  }
  const out = new Map();
  for (const [name, group] of byBase) {
    if (group.length === 1) {
      out.set(group[0].id, { name, hint: null });
      continue;
    }
    const segs = group.map((t) => dirname(relPathOf(t)).replace(/^\/+|\/+$/g, "").split("/").filter(Boolean));
    const maxDepth = Math.max(1, ...segs.map((s) => s.length));
    let depth = 1;
    while (depth < maxDepth) {
      const seen = new Set(segs.map((s) => s.slice(-depth).join("/")));
      if (seen.size === group.length) break;
      depth++;
    }
    group.forEach((t, i) => {
      const hint = segs[i].slice(-depth).join("/") || (t.on ? `@${t.on}` : "/");
      out.set(t.id, { name, hint });
    });
  }
  return out;
}

// Cursor scan so checking a multi-megabyte file never allocates an array of lines.
function hasLongLine(text, max = LONG_LINE) {
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    if (nl === -1) return text.length - at > max;
    if (nl - at > max) return true;
    at = nl + 1;
  }
  return false;
}

export default class EditorPane extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.id = p.id ?? `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.tabs = [];
    this.active = null;
    this.closedTabs = [];
    this.watchers = new Set();
    this.tabScroll = ScrollHandle.new();
    this.pressedTab = null;
    this.dragOverTab = null;
    this.hoverTab = null;
    this.wheelAt = 0;
    this.batchDiscardKey = null;
    this.batchDiscardUntil = 0;
    this.closed = false;

    this.seen = shared("mayonaka-editor.open")?.n ?? 0;
    this.movedSeen = shared("mayonaka-editor.moved")?.n ?? 0;
    this.deletedSeen = shared("mayonaka-editor.deleted")?.n ?? 0;
    this.menuSeen = shared(MENU_KEY)?.n ?? 0;

    // Restore persisted multi-tab state (with seamless migration from legacy single-file {file, on, root}).
    const saved = this.id ? shared("mayonaka-editor.files")?.[this.id] : null;
    if (Array.isArray(saved?.tabs) && saved.tabs.length > 0) {
      for (const entry of saved.tabs) {
        if (entry?.file) this.tabs.push(this.makeTab(entry));
      }
      if (this.tabs.length > 0) {
        this.active = this.tabs.some((t) => t.id === saved.active) ? saved.active : this.tabs[0].id;
      }
    } else if (saved?.file) {
      const tab = this.makeTab(saved);
      this.tabs.push(tab);
      this.active = tab.id;
    } else if (Array.isArray(p.tabs) && p.tabs.length > 0) {
      for (const entry of p.tabs) {
        if (entry?.file) this.tabs.push(this.makeTab(entry));
      }
      if (this.tabs.length > 0) this.active = this.tabs[this.tabs.length - 1].id;
    } else if (p.file) {
      const tab = this.makeTab({ file: p.file, on: p.on ?? null, root: p.root ?? null });
      this.tabs.push(tab);
      this.active = tab.id;
    }

    // Only load the active tab eagerly on startup; background tabs load on demand when selected.
    const cur = this.currentTab();
    if (cur) {
      this.ensureLoaded(cur, cx);
      this.syncShared();
    }
    this.gcCachedImages(cx);

    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (!c || !this.shouldHandleCommand(c)) continue;
        await this.handleCommand(c, cx);
        cx.notify();
      }
    });
  }

  makeTab({ id = null, file, on = null, root = null, mode = null }) {
    const defaultMode = isMarkdown(file) || isImage(file) ? "preview" : "source";
    return {
      id: id ?? `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      file,
      on: on ?? null,
      root: root ?? null,
      mode: (mode === "preview" || mode === "source") ? mode : defaultMode,
      state: null,
      loading: false,
      original: null,
      digest: null,
      dirty: false,
      pending: false,
      saving: false,
      pendingSave: null,
      pendingCheck: null,
      syncing: null,
      pendingVerifyChanges: 0,
      error: null,
      lastError: null,
      image: null,
      imageError: null,
      parsed: null,
      edit: null,
      moved: null,
      lastUsed: Date.now(),
      discardUntil: 0,
    };
  }

  currentTab() {
    return this.tabs.find((t) => t.id === this.active) ?? this.tabs[0] ?? null;
  }

  myPaneId() {
    if (!this.id) return null;
    const ids = shared("mayonaka-editor.ids") ?? {};
    const allPanes = panes();
    for (const [paneId, eid] of Object.entries(ids)) {
      if (eid === this.id && allPanes.some((p) => p.pane === paneId && p.mod === "mayonaka-editor")) {
        return paneId;
      }
    }
    const unclaimed = allPanes.filter((p) => p.mod === "mayonaka-editor" && !ids[p.pane]);
    const cand = unclaimed.find((p) => p.focused) ?? (unclaimed.length === 1 ? unclaimed[0] : null);
    if (cand) {
      setShared("mayonaka-editor.ids", { ...ids, [cand.pane]: this.id });
      return cand.pane;
    }
    return null;
  }

  shouldHandleCommand(cmd) {
    if (cmd === "autosave-on" || cmd === "autosave-off") return true;
    const target = shared("mayonaka-editor.target");
    if (target?.id && Date.now() - (target.n ?? 0) < 1500) {
      return target.id === this.id;
    }
    const f = focused(), pid = this.myPaneId();
    if (pid && f?.pane === pid) return true;
    if (pid && f?.tab) {
      const inTab = panes().filter((p) => p.mod === "mayonaka-editor" && p.tab === f.tab);
      if (inTab.length === 1 && inTab[0].pane === pid) return true;
    }
    return false;
  }

  async handleCommand(c, cx) {
    const cur = this.currentTab();
    if (c === "save") {
      if (cur) await this.saveTab(cur, cx);
    } else if (c === "autosave-on") {
      setShared(AUTOSAVE, true);
      for (const t of this.tabs) if (t.dirty || t.pending) this.touchTab(t, cx);
    } else if (c === "autosave-off") {
      setShared(AUTOSAVE, false);
      for (const t of this.tabs) {
        t.pendingSave?.cancel();
        t.pendingSave = null;
        if (t.dirty || t.pending) this.touchTab(t, cx);
      }
    } else if (c === "toggle") {
      if (cur && hasPreview(cur.file)) {
        this.commitTab(cur, false);
        cur.mode = cur.mode === "preview" ? "source" : "preview";
        if (cur.mode === "source" && isSvg(cur.file) && !cur.state) this.loadTab(cur, cx);
        this.syncShared();
      }
    } else if (c === "close-tab") {
      if (cur) await this.closeTabs([cur.id], cx);
      else this.closeOwnPane();
    } else if (c === "close-others") {
      if (cur) await this.closeTabs(this.tabs.filter((t) => t.id !== cur.id).map((t) => t.id), cx);
    } else if (c === "close-saved") {
      await this.closeTabs(this.tabs.filter((t) => !t.dirty && !t.pending).map((t) => t.id), cx);
    } else if (c === "close-all" || c === "close-pane") {
      await this.closeTabs(this.tabs.map((t) => t.id), cx, { forcePaneClose: true });
    } else if (c === "next-tab" || c === "prev-tab") {
      this.stepTab(c === "next-tab" ? 1 : -1, cx);
    } else if (c === "reopen-tab") {
      const last = this.closedTabs.pop();
      if (last) {
        this.openFile({ file: last.file, on: last.on, root: last.root, mode: last.mode, index: last.index }, cx);
      }
    }
  }

  gcCachedImages(cx) {
    cx.spawn(async () => {
      try {
        const dir = `${appHome()}/${CACHE}`;
        const entries = await readdir(dir).catch(() => []);
        const ids = new Set(Object.values(shared("mayonaka-editor.ids") ?? {}));
        if (this.id) ids.add(this.id);
        const ownTabs = new Set(this.tabs.map((t) => t.id));
        for (const name of entries) {
          if (name === "save") continue;
          const m = /^(e[a-z0-9]+)-(?:(t[a-z0-9]+)-)?/.exec(name);
          if (!m) continue;
          const [, eid, tid] = m;
          if (!ids.has(eid) || (eid === this.id && (!tid || !ownTabs.has(tid)))) {
            await unlink(`${dir}/${name}`).catch(() => {});
          }
        }
      } catch { /* ignore cache cleanup errors */ }
    });
  }

  cancelTabTimers(tab) {
    tab.pendingSave?.cancel(); tab.pendingSave = null;
    tab.pendingCheck?.cancel(); tab.pendingCheck = null;
  }

  autosaveMs(tab) {
    const n = tab.digest?.bytes ?? 0;
    return n <= LARGE_MD ? AUTOSAVE_SMALL_MS : n <= MEDIUM_MAX ? AUTOSAVE_MEDIUM_MS : AUTOSAVE_LARGE_MS;
  }

  // Guards programmatic set_value calls whether the host fires "change" synchronously, on a later turn, or not at all.
  setEditorValue(tab, text) {
    if (!tab.state) return;
    let firedSync = false;
    tab.syncing = () => { firedSync = true; };
    try { tab.state.set_value(text); }
    finally { tab.syncing = null; }
    if (!firedSync) tab.pendingVerifyChanges = (tab.pendingVerifyChanges ?? 0) + 1;
  }

  syncShared() {
    if (!this.id) return;
    const prevMap = shared("mayonaka-editor.files") ?? {};
    const cur = this.currentTab();
    if (!this.tabs.length) {
      if (this.id in prevMap) {
        const next = { ...prevMap };
        delete next[this.id];
        setShared("mayonaka-editor.files", next);
      }
      return;
    }
    const dirty = this.tabs.some((t) => t.dirty || t.pending);
    const entry = {
      file: cur?.file ?? null,
      on: cur?.on ?? null,
      root: cur?.root ?? null,
      dirty,
      active: this.active,
      tabs: this.tabs.map((t) => ({
        id: t.id,
        file: t.file,
        on: t.on ?? null,
        root: t.root ?? null,
        mode: t.mode,
        dirty: Boolean(t.dirty || t.pending),
      })),
    };
    const old = prevMap[this.id];
    if (old && JSON.stringify(old) === JSON.stringify(entry)) return;
    setShared("mayonaka-editor.files", { ...prevMap, [this.id]: entry });
  }

  // Soft-hibernates oldest clean background EditorStates only past generous tab/byte watermarks so normal sessions keep full undo stacks.
  hibernateIfNeeded() {
    const clean = this.tabs
      .filter((t) => t.id !== this.active && t.state && !t.dirty && !t.pending && !t.saving && !t.edit)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let bytes = clean.reduce((sum, t) => sum + (t.digest?.bytes ?? 0), 0);
    while (clean.length > MIN_KEEP_CLEAN && (clean.length > MAX_CLEAN_TABS || bytes > MAX_CLEAN_BYTES)) {
      const victim = clean.shift();
      bytes -= victim.digest?.bytes ?? 0;
      this.cancelTabTimers(victim);
      victim.state?.release();
      victim.state = null;
      victim.original = null;
      victim.parsed = null;
      victim.moved = null;
    }
  }

  ensureLoaded(tab, cx) {
    if (!tab) return;
    if (isImage(tab.file) && !tab.image && !tab.imageError) this.loadImage(tab, cx);
    if ((!isImage(tab.file) || isSvg(tab.file)) && !tab.state && !tab.loading) {
      this.loadTab(tab, cx);
    }
    this.ensureWatches(cx);
  }

  openFile({ file, on = null, root = null, mode = null, index = null }, cx) {
    if (!file) return;
    const normOn = on ?? null;
    const existing = this.tabs.find((t) => t.file === file && (t.on ?? null) === normOn);
    if (existing) {
      if (root && !existing.root) existing.root = root;
      this.selectTab(existing.id, cx, true);
      return;
    }
    const tab = this.makeTab({ file, on: normOn, root: root ?? this.currentTab()?.root ?? null, mode });
    if (typeof index === "number" && index >= 0 && index <= this.tabs.length) {
      this.tabs.splice(index, 0, tab);
    } else {
      this.tabs.push(tab);
    }
    this.selectTab(tab.id, cx, true);
  }

  selectTab(id, cx, scrollIntoView = false) {
    const next = this.tabs.find((t) => t.id === id);
    if (!next) return;
    const prev = this.currentTab();
    if (prev && prev.id !== next.id) this.commitTab(prev, false);
    this.active = next.id;
    next.lastUsed = Date.now();
    this.ensureLoaded(next, cx);
    this.hibernateIfNeeded();
    this.syncShared();
    if (scrollIntoView) {
      const idx = this.tabs.indexOf(next);
      if (idx >= 0) this.tabScroll.scroll_to_item(idx);
    }
    cx.notify();
  }

  stepTab(delta, cx) {
    if (this.tabs.length < 2) return;
    const curIdx = Math.max(0, this.tabs.findIndex((t) => t.id === this.active));
    const nextIdx = (curIdx + delta + this.tabs.length) % this.tabs.length;
    this.selectTab(this.tabs[nextIdx].id, cx, true);
  }

  finishTabDrag(toIdx, cx) {
    const fromIdx = this.pressedTab;
    this.pressedTab = null;
    this.dragOverTab = null;
    if (fromIdx === null || fromIdx === toIdx || fromIdx < 0 || fromIdx >= this.tabs.length || toIdx < 0 || toIdx >= this.tabs.length) {
      cx.notify();
      return;
    }
    const [moved] = this.tabs.splice(fromIdx, 1);
    this.tabs.splice(toIdx, 0, moved);
    this.syncShared();
    cx.notify();
  }

  destroyTab(tab, remember = true) {
    const idx = this.tabs.indexOf(tab);
    if (idx < 0) return -1;
    this.cancelTabTimers(tab);
    if (tab.edit?.ta) { tab.edit.ta.release(); tab.edit = null; }
    tab.state?.release(); tab.state = null;
    this.dropImage(tab);
    this.tabs.splice(idx, 1);
    if (remember) {
      this.closedTabs = this.closedTabs.filter((c) => !(c.file === tab.file && (c.on ?? null) === (tab.on ?? null)));
      this.closedTabs.push({ file: tab.file, on: tab.on, root: tab.root, mode: tab.mode, index: idx });
      if (this.closedTabs.length > MAX_CLOSED_HISTORY) this.closedTabs.shift();
    }
    return idx;
  }

  closeOwnPane() {
    const pid = this.myPaneId();
    if (this.id) {
      const ids = { ...(shared("mayonaka-editor.ids") ?? {}) };
      for (const [k, v] of Object.entries(ids)) if (v === this.id) delete ids[k];
      setShared("mayonaka-editor.ids", ids);
      const files = { ...(shared("mayonaka-editor.files") ?? {}) };
      delete files[this.id];
      setShared("mayonaka-editor.files", files);
    }
    run("pane.close", pid ? { pane: pid } : {});
  }

  async closeTabs(ids, cx, { forcePaneClose = false, remember = true } = {}) {
    const idSet = new Set(ids);
    const targets = this.tabs.filter((t) => idSet.has(t.id));
    if (!targets.length) {
      if (forcePaneClose && !this.tabs.length) this.closeOwnPane();
      return;
    }
    for (const t of targets) {
      this.commitTab(t, false);
      if (t.dirty && t.state && t.original !== null) {
        t.dirty = t.state.value() !== t.original;
      }
    }
    // When auto save is active, flush cleanable dirty edits to disk right before closing so typing + ⌘W never loses or nags.
    if (shared(AUTOSAVE) !== false) {
      for (const t of targets) {
        if ((t.dirty || t.pending) && !t.lastError && t.original !== null) {
          await this.saveTab(t, cx);
        }
      }
    }

    const clean = targets.filter((t) => !t.dirty && !t.pending && !t.saving);
    const dirty = targets.filter((t) => t.dirty || t.pending || t.saving);
    let closedActiveNeighbor = null;

    for (const t of clean) {
      const wasActive = t.id === this.active;
      const idx = this.destroyTab(t, remember);
      if (wasActive && this.tabs.length > 0) {
        closedActiveNeighbor = this.tabs[Math.min(idx, this.tabs.length - 1)]?.id ?? null;
      }
    }

    if (dirty.length > 0) {
      const now = Date.now();
      const key = dirty.map((t) => t.id).join(",");
      const confirmed = (dirty.length === 1 && now < dirty[0].discardUntil)
        || (this.batchDiscardKey === key && now < this.batchDiscardUntil);
      if (confirmed) {
        this.batchDiscardKey = null;
        this.batchDiscardUntil = 0;
        for (const t of dirty) {
          const wasActive = t.id === this.active;
          const idx = this.destroyTab(t, remember);
          if (wasActive && this.tabs.length > 0) {
            closedActiveNeighbor = this.tabs[Math.min(idx, this.tabs.length - 1)]?.id ?? null;
          }
        }
      } else {
        const first = dirty[0];
        first.discardUntil = now + DISCARD_WINDOW_MS;
        this.batchDiscardKey = key;
        this.batchDiscardUntil = now + DISCARD_WINDOW_MS;
        this.selectTab(first.id, cx, true);
        notify({
          title: "Unsaved changes",
          body: dirty.length === 1
            ? `${baseName(first.file)} has unsaved edits. Save with ⌘S, or repeat to discard.`
            : `${dirty.length} files have unsaved edits. Save with ⌘S, or repeat to discard all.`,
          level: "warning",
        });
        return;
      }
    }

    if (!this.tabs.length) {
      this.active = null;
      this.closeOwnPane();
      return;
    }

    if (!this.tabs.some((t) => t.id === this.active)) {
      const fallback = (closedActiveNeighbor && this.tabs.find((t) => t.id === closedActiveNeighbor)) ?? this.tabs[this.tabs.length - 1];
      this.selectTab(fallback.id, cx, true);
    } else {
      this.syncShared();
      cx.notify();
    }
  }

  // mayonaka-files moved or renamed a file or folder. Every open tab matching `from` follows with its unsaved buffer intact.
  follow({ from, to, on = null }, cx) {
    if (!from || !to) return;
    let changed = false;
    for (const tab of this.tabs) {
      if ((tab.on ?? null) !== (on ?? null)) continue;
      const nextFile = tab.file === from ? to : tab.file.startsWith(from + "/") ? to + tab.file.slice(from.length) : null;
      if (!nextFile) continue;
      tab.file = nextFile;
      if (tab.image) tab.image.file = nextFile;
      tab.error = null;
      changed = true;
      if (tab.state || tab.image || tab.id === this.active) this.loadTab(tab, cx);
    }
    if (changed) {
      this.ensureWatches(cx);
      this.syncShared();
      cx.notify();
    }
  }

  // mayonaka-files deleted a file or folder. Clean tabs close; dirty tabs stay open without resurrecting via auto save.
  handleDeleted({ path, dir, on = null }, cx) {
    if (!path) return;
    const cleanIds = [];
    let dirtyTouched = false;
    for (const tab of this.tabs) {
      if ((tab.on ?? null) !== (on ?? null)) continue;
      const hit = tab.file === path || (dir && tab.file.startsWith(path + "/"));
      if (!hit) continue;
      this.commitTab(tab, false);
      if (tab.dirty && tab.state && tab.original !== null) {
        tab.dirty = tab.state.value() !== tab.original;
      }
      if (!tab.dirty && !tab.pending && !tab.saving) {
        cleanIds.push(tab.id);
      } else {
        this.cancelTabTimers(tab);
        tab.original = null;
        tab.digest = null;
        tab.dirty = true;
        dirtyTouched = true;
      }
    }
    if (cleanIds.length > 0) {
      cx.spawn((cx) => this.closeTabs(cleanIds, cx, { remember: false }));
    } else if (dirtyTouched) {
      this.syncShared();
      cx.notify();
    }
  }

  loadTab(tab, cx) {
    const file = tab.file;
    if (isImage(file)) {
      this.loadImage(tab, cx);
      if (!isSvg(file)) return;
    }
    tab.loading = true;
    cx.spawn(async (cx) => {
      try {
        const clean = Boolean(tab.state && !tab.dirty && !tab.saving && !tab.edit && !tab.pending);
        const res = await readEditorFile(file, tab.on, clean ? tab.digest : null);
        if (!this.tabs.includes(tab) || tab.file !== file) return;
        if (res.status === "missing") tab.error = "This file is no longer available";
        else if (res.status === "unchanged") tab.error = null;
        else if (tab.state) {
          tab.error = null;
          if (!tab.dirty && !tab.saving && !tab.edit && !tab.pending && res.text !== tab.original) {
            tab.original = res.text;
            tab.digest = res.digest;
            this.setEditorValue(tab, res.text);
          }
        } else {
          const { text, digest } = res;
          tab.error = null;
          tab.original = text;
          tab.digest = digest;
          if (isMarkdown(file) && digest.bytes > LARGE_MD) tab.mode = "source";
          const t = theme(), ext = file.includes(".") ? file.split(".").pop().toLowerCase() : "txt";
          tab.state = EditorState.new({
            ...(hasLongLine(text) ? {} : { language: LANG[ext] ?? ext }),
            value: text,
            folding: digest.bytes <= FOLD_MAX,
            font_family: settings().font_family, font_size: 13, soft_wrap: isMarkdown(file),
            syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi6 },
          });
          // Keystrokes mark the buffer dirty optimistically instead of copying a multi-megabyte Rope across FFI on every key;
          // saveTab(), closeTabs() and the idle check (while auto save is off) verify against `original` once typing pauses.
          tab.state.on("change", (_e, cx) => {
            if (!this.tabs.includes(tab)) return;
            if (tab.syncing) { tab.syncing(); return; }
            if (tab.pendingVerifyChanges > 0) {
              tab.pendingVerifyChanges--;
              const dirty = tab.original === null || tab.state.value() !== tab.original;
              if (dirty !== tab.dirty || tab.mode === "preview") {
                tab.dirty = dirty;
                this.syncShared();
                cx.notify();
              }
              if (dirty) this.touchTab(tab, cx);
              return;
            }
            if (!tab.dirty || tab.mode === "preview") {
              tab.dirty = true;
              this.syncShared();
              cx.notify();
            }
            this.touchTab(tab, cx);
          });
          this.hibernateIfNeeded();
        }
      } catch (e) {
        if (this.tabs.includes(tab) && tab.file === file) {
          tab.error = e instanceof BinaryFileError ? e.message : "Cannot open this file (too large, over 8 MiB, or unreadable)";
        }
      } finally {
        tab.loading = false;
        cx.notify();
      }
    });
  }

  loadImage(tab, cx) {
    const file = tab.file, on = tab.on;
    cx.spawn(async (cx) => {
      try {
        const max = on ? MAX_REMOTE_IMAGE : MAX_IMAGE;
        const size = await exec("sh", ["-c", 'wc -c < "$1"', "size", file], { on }).catch(() => null);
        if (size?.code === 0 && Number(size.stdout.trim()) > max) throw new Error(`Image over ${formatBytes(max)} · not previewed`);
        const viaExec = async () => {
          const r = await exec("sh", ["-c", 'base64 < "$1"', "base64", file], { on });
          if (r.code !== 0) throw new Error(r.stderr.trim() || "This file is no longer available");
          return Buffer.from(r.stdout.replace(/\s+/g, ""), "base64");
        };
        // fs only reads under the home folder; elsewhere (/tmp, other volumes) the bytes come through exec, with its 8 MiB cap.
        let bytes;
        try { bytes = on ? await viaExec() : await readFile(file); }
        catch (e) { if (on) throw e; bytes = await viaExec(); }
        if (!this.tabs.includes(tab) || tab.file !== file) return;
        if (bytes.length > max) throw new Error(`Image over ${formatBytes(max)} · not previewed`);
        const ext = file.split(".").pop().toLowerCase(), prefix = `${this.id ?? "pane"}-${tab.id}-`;
        const name = `${prefix}${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}.${ext}`;
        const dir = `${appHome()}/${CACHE}`;
        await mkdir(dir, { recursive: true });
        // Content-addressed and scoped per tab, so opening a second image tab never deletes the first tab's cached pixels.
        for (const old of await readdir(dir).catch(() => [])) if (old.startsWith(prefix) && old !== name) await unlink(`${dir}/${old}`).catch(() => {});
        await writeFile(`${dir}/${name}`, bytes);
        if (!this.tabs.includes(tab) || tab.file !== file) return;
        tab.image = { file, path: `${CACHE}/${name}`, bytes: bytes.length, ...(imageSize(bytes) ?? {}) };
        tab.imageError = null;
      } catch (e) {
        if (this.tabs.includes(tab) && tab.file === file) tab.imageError = String(e?.message ?? e);
      } finally {
        cx.notify();
      }
    });
  }

  dropImage(tab) {
    const path = tab.image?.path;
    tab.image = null;
    if (path) unlink(`${appHome()}/${path}`).catch(() => {});
  }

  async close() {
    this.closed = true;
    for (const tab of this.tabs) {
      this.cancelTabTimers(tab);
      if (tab.edit?.ta) { tab.edit.ta.release(); tab.edit = null; }
      tab.state?.release(); tab.state = null;
      this.dropImage(tab);
    }
    this.tabScroll?.release();
  }

  ensureWatches(cx) {
    // watchFolder only sees this computer; a file on another machine is checked again when it is saved.
    const dirs = new Set();
    for (const tab of this.tabs) {
      if (!tab.on && (tab.state || tab.image || tab.id === this.active)) dirs.add(dirname(tab.file));
    }
    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue;
      this.watchers.add(dir);
      cx.spawn(async (cx) => {
        try {
          while (!this.closed) {
            const changed = await watchFolder(dir);
            const matching = this.tabs.filter((t) => !t.on && dirname(t.file) === dir && (t.state || t.image || t.id === this.active));
            if (!matching.length) break;
            for (const tab of matching) {
              while (this.tabs.includes(tab) && tab.saving) await cx.sleep(20);
              if (this.tabs.includes(tab) && (changed.includes(tab.file) || changed.includes(dir))) {
                this.loadTab(tab, cx);
              }
            }
          }
        } catch { /* the folder went away; the next open watches again */ }
        finally { this.watchers.delete(dir); }
      });
    }
  }

  async saveTab(tab, cx, auto = false) {
    if (!tab) return;
    this.cancelTabTimers(tab);
    const wasDirty = tab.dirty;
    this.commitTab(tab, true);
    if (!tab.state || !tab.dirty || tab.saving) {
      if (wasDirty !== tab.dirty) { this.syncShared(); cx.notify(); }
      return;
    }
    const { state, file, on, original } = tab, text = state.value();
    if (original !== null && text === original) {
      tab.dirty = false;
      this.syncShared();
      cx.notify();
      return;
    }
    tab.saving = true;
    try {
      const digest = await writeEditorText(file, text, original, on, `${this.id ?? "pane"}-${tab.id}`, tab.digest);
      tab.lastError = null;
      // A save on another machine (or of a large file) takes a while and typing goes on meanwhile.
      if (this.tabs.includes(tab) && tab.state === state) {
        tab.original = text;
        tab.digest = digest;
        const stillDirty = state.value() !== text;
        tab.dirty = stillDirty;
        if (!stillDirty) this.cancelTabTimers(tab);
        if (isSvg(file) && tab.mode === "preview") this.loadImage(tab, cx);
      }
    } catch (e) {
      const name = baseName(file);
      const body = `${name}: ${e?.message ?? e}`;
      // The timer failing again the same way stays quiet: the dot is still on, and ⌘S says it again.
      if (!auto || body !== tab.lastError) notify({ title: "Not saved", body, level: "error" });
      tab.lastError = body;
    } finally {
      tab.saving = false;
    }
    this.syncShared();
    cx.notify();
  }

  // A timer handler returns nothing, so the save runs in a task, where cx.spawn reports a rejection instead of losing it.
  touchTab(tab, cx) {
    this.cancelTabTimers(tab);
    if (shared(AUTOSAVE) === false) {
      tab.pendingCheck = cx.timer.after(DIRTY_CHECK_MS, (cx) => {
        tab.pendingCheck = null;
        if (!this.tabs.includes(tab) || !tab.state || tab.pending) return;
        const dirty = tab.original === null || tab.state.value() !== tab.original;
        if (dirty !== tab.dirty) { tab.dirty = dirty; this.syncShared(); cx.notify(); }
      });
      return;
    }
    // Deleted dirty buffers wait for an explicit ⌘S instead of silently recreating on a timer.
    if (tab.original === null) return;
    tab.pendingSave = cx.timer.after(this.autosaveMs(tab), (cx) => {
      tab.pendingSave = null;
      if (this.tabs.includes(tab)) cx.spawn((cx) => this.autoSaveTab(tab, cx));
    });
  }

  async autoSaveTab(tab, cx) {
    if (!this.tabs.includes(tab) || shared(AUTOSAVE) === false || !tab.state || !(tab.dirty || tab.pending) || tab.original === null) return;
    if (tab.saving) return this.touchTab(tab, cx);
    await this.saveTab(tab, cx, true);
  }

  link(tab, url, cx) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) { exec("open", [url]); return; }
    const path = decodeURIComponent(url.split("#")[0]);
    if (path) this.openFile({ file: resolve(tab.file, path), on: tab.on, root: tab.root }, cx);
  }

  modeToggle(t, tab, mode, iconName) {
    const on = tab.mode === mode;
    return div().id(`mode-${mode}`).p(4).rounded(5).cursor_pointer()
      .text_color(on ? t.foreground : t.dim).when(on, (el) => el.bg(t.selected)).hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => {
        this.commitTab(tab, false);
        tab.mode = mode;
        if (mode === "source" && isSvg(tab.file) && !tab.state) this.loadTab(tab, cx);
        if (mode === "preview" && isSvg(tab.file)) this.loadImage(tab, cx);
        this.syncShared();
        cx.notify();
      })
      .child(svg(`mods/mayonaka-editor/${iconName}.svg`).size(14));
  }

  openTabMenu(tab) {
    const idx = this.tabs.indexOf(tab);
    const platform = win()?.platform;
    const items = [];
    const add = (label, action, icon, sep = false) => items.push({ label, action, icon, sep: sep && items.length > 0 });
    add("Close", "close", "mods/pane/close.svg");
    if (this.tabs.length > 1) add("Close Others", "close-others", "mods/pane/close.svg");
    if (idx >= 0 && idx < this.tabs.length - 1) add("Close to the Right", "close-right", "mods/pane/close.svg");
    if (this.tabs.some((t) => !t.dirty && !t.pending)) add("Close Saved", "close-saved", "mods/pane/close.svg");
    if (this.tabs.length > 1) add("Close All", "close-all", "mods/pane/close.svg");
    add("Copy Path", "copy-path", "copy", true);
    if (tab.root && tab.file.startsWith(tab.root + "/")) add("Copy Relative Path", "copy-relative", "copy");
    if (!tab.on) {
      add(platform === "macos" ? "Reveal in Finder" : platform === "windows" ? "Show in Explorer" : "Open Containing Folder", "reveal", "folder");
    }
    const height = 10 + items.length * 31 + items.filter((i) => i.sep).length * 9;
    openOverlay({
      mod: "mayonaka-files-menu",
      kind: "popup",
      width: 224,
      height,
      props: { stage: "menu", replyKey: MENU_KEY, editor: this.id, tabId: tab.id, path: tab.file, items },
    });
  }

  performMenuAction(req, cx) {
    const tab = this.tabs.find((t) => t.id === req.tabId);
    const idx = tab ? this.tabs.indexOf(tab) : -1;
    switch (req.action) {
      case "close":
        if (tab) cx.spawn((cx) => this.closeTabs([tab.id], cx));
        return;
      case "close-others":
        if (tab) cx.spawn((cx) => this.closeTabs(this.tabs.filter((t) => t.id !== tab.id).map((t) => t.id), cx));
        return;
      case "close-right":
        if (idx >= 0) cx.spawn((cx) => this.closeTabs(this.tabs.slice(idx + 1).map((t) => t.id), cx));
        return;
      case "close-saved":
        cx.spawn((cx) => this.closeTabs(this.tabs.filter((t) => !t.dirty && !t.pending).map((t) => t.id), cx));
        return;
      case "close-all":
        cx.spawn((cx) => this.closeTabs(this.tabs.map((t) => t.id), cx, { forcePaneClose: true }));
        return;
      case "copy-path":
      case "copy-relative": {
        if (!tab) return;
        const val = req.action === "copy-path" ? tab.file : relPathOf(tab);
        cx.write_to_clipboard(val);
        notify({ title: "Copied", body: val, level: "success", timeout: 2000 });
        return;
      }
      case "reveal": {
        if (!tab || tab.on) return;
        const abs = tab.file, platform = win()?.platform;
        const args = platform === "macos" ? ["open", ["-R", abs]]
          : platform === "windows" ? ["explorer", [`/select,${abs.replace(/\//g, "\\")}`]]
          : ["xdg-open", [dirname(abs)]];
        exec(args[0], args[1]).catch((e) => notify({ title: "Couldn't open", body: String(e?.message ?? e), level: "error" }));
      }
    }
  }

  // The document stays in the tab's EditorState; a block edit is a Textarea over one [start, end) slice of it.
  blocks(tab) {
    const text = tab.state.value();
    if (tab.parsed?.text !== text) {
      const list = splitBlocks(text);
      tab.parsed = { text, list, refs: refDefs(list) };
    }
    return tab.parsed;
  }

  edit_block(tab, b, cx) {
    if (tab.edit?.ta && tab.edit.start === b.start && tab.edit.src === b.src) return;
    const before = tab.parsed;
    this.commitTab(tab, false);
    let { start, end } = b;
    if (tab.moved && tab.moved.from === before && start >= tab.moved.at) { start += tab.moved.delta; end += tab.moved.delta; }
    const doc = tab.state.value();
    if (b.append) start = end = doc.length;
    else if (doc.slice(start, end) !== b.src) { cx.notify(); return; }
    const ta = TextareaState.new({ value: b.src });
    ta.set_auto_grow(1, 1000);
    ta.set_value({ text: b.src, tokens: tokenize(b.src) });
    ta.on("change", (_e, cx) => {
      if (tab.edit?.ta === ta) {
        this.restyle(tab, tab.edit);
        this.syncShared();
        this.touchTab(tab, cx);
        cx.notify();
      }
    });
    tab.edit = { ta, start, end, src: b.src, append: Boolean(b.append), prev: b.src, open: null, indent: b.indent ?? 0 };
    tab.pending = false;
    cx.spawn(async (cx) => { await cx.sleep(0); if (tab.edit?.ta === ta) ta.focus(); });
    cx.notify();
  }

  restyle(tab, e) {
    const ta = e.ta, text = ta.value(), d = diff(e.prev, text), changed = text !== e.prev;
    if (changed && e.open) {
      const delta = (d.after - d.start) - (d.before - d.start);
      if (d.before <= e.open.start) e.open = { start: e.open.start + delta, end: e.open.end + delta };
      else if (d.start >= e.open.start && d.before <= e.open.end) e.open = { start: e.open.start, end: e.open.end + delta };
      else e.open = null;
    }
    const mode = blockMode(text);
    if (changed && mode === "rich" && d.before === d.start && d.after === d.start + 1 && text[d.start] === "\n") {
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
      tab.pending = e.prev !== e.src;
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
      if (caret !== null && caret > s.range.start && caret < s.range.end) continue;
      if (content.tokens.some((h) => wanted.has(key(h)) && overlaps(h.range, s.range))) continue;
      ta.replace_range_with_token(s.range, s.token);
    }
    if (moved && caret !== null) ta.set_selected_range({ start: caret, end: caret });
    e.prev = ta.value();
    tab.pending = e.prev !== e.src;
  }

  token_click(tab, ev, cx) {
    const e = tab.edit;
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

  token_view(tab, ctx, t) {
    const s = ctx.token.text;
    switch (ctx.token.id) {
      case "marker": {
        const m = parseMarker(s), parts = [];
        for (let q = 0; q < m.quotes; q++) parts.push(div().w(3).h(ctx.line_height).rounded(2).bg(t.border));
        if (m.heading) parts.push(div().text_size(10).text_color(t.dim).child("H" + m.heading));
        if (m.bullet) parts.push(div().pl(Math.max(0, m.indent - (tab.edit?.indent ?? 0)) * 7).text_color(t.dim).child(/\d/.test(m.bullet) ? m.bullet : "•"));
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

  commitTab(tab, keep = false) {
    const e = tab?.edit;
    if (!e || !tab.state) return;
    const text = tab.state.value(), next = e.ta.value(), from = tab.parsed;
    if (next !== e.src) {
      let updated = text;
      if (e.append) {
        if (next.trim()) {
          const r = appendBlock(text, next);
          updated = r.text;
          this.setEditorValue(tab, updated);
          Object.assign(e, { start: r.start, end: r.end, src: updated.slice(r.start, r.end), append: false });
        }
      } else {
        const r = replaceBlock(text, e.start, e.end, next);
        updated = r.text;
        this.setEditorValue(tab, updated);
        tab.moved = { from, at: r.at, delta: r.delta };
        Object.assign(e, { end: e.start + next.length, src: next });
      }
      tab.dirty = tab.original === null || updated !== tab.original;
    }
    tab.pending = false;
    if (keep) return;
    tab.edit = null;
    e.ta.release();
    this.syncShared();
  }

  block_textarea(tab, e, t) {
    const text = e.ta.value(), mode = blockMode(text), first = parseMarker(text);
    const area = Textarea.new(e.ta).w_full()
      .token((ctx) => this.token_view(tab, ctx, t))
      .on_token_click((ev, cx) => this.token_click(tab, ev, cx));
    if (mode !== "rich") return area.font_family(settings().font_family).text_size(13);
    if (first.heading) return area.font_bold().text_size(HEADING[first.heading]);
    return area.when(first.quotes > 0, (el) => el.text_color(t.muted));
  }

  blockViews(tab, t) {
    const { list, refs } = this.blocks(tab), e = tab.edit, out = [];
    const tail = (b) => (refs && b.kind !== "code" ? "\n\n" + refs : "");
    const md = (b) => (b.kind === "front" ? "```yaml\n" + b.src.replace(/^---\r?\n|\r?\n---$/g, "") + "\n```" : b.src) + tail(b);
    const editor = (depth = 0) => div().id(`block-edit-${tab.id}`).w_full().pl(8 + depth * 24).pr(8).mx(-8).py(2).rounded(6).border(1).border_color(t.border)
      .on_key_down((ev, cx) => { if (ev.keystroke === "escape") { this.commitTab(tab, false); cx.notify(); } })
      .on_mouse_down_out((ev, cx) => { if (ev.position.x < 0 || ev.position.y < 0) return; this.commitTab(tab, false); cx.notify(); })
      .child(this.block_textarea(tab, e, t));
    const view = (id, u, source, depth = 0) => div().id(`${tab.id}-${id}`).w_full().pl(8 + depth * 24).pr(8).mx(-8).rounded(6).cursor_text()
      .hover((s) => s.bg(t.surface))
      .on_click((_ev, cx) => this.edit_block(tab, u, cx))
      .child(TextView.markdown(`md-${tab.id}-${tab.file}-${id}`, source).on_link_click((url, cx) => { cx.stop_propagation(); this.link(tab, url, cx); }));
    const editing = (u) => e && !e.append && u.end > e.start && u.start < e.end;
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
        const loose = /\n[ \t]*\r?\n/.test(b.src);
        out.push(v_flex().id(`${tab.id}-list-${i}`).w_full().gap(loose ? 8 : 0).children(rows));
        return;
      }
      if (editing(b)) { if (!shown) { out.push(editor()); shown = true; } return; }
      if (before(b)) { out.push(editor()); shown = true; }
      out.push(view(`block-${i}`, b, md(b)).when(b.kind === "heading" && i > 0, (el) => el.mt(14)));
    });
    if (e && !shown) out.push(editor());
    if (!e?.append) out.push(div().id(`block-append-${tab.id}`).w_full().min_h(48).flex_1().cursor_text()
      .on_click((_ev, cx) => this.edit_block(tab, { append: true, start: 0, end: 0, src: "", kind: "paragraph" }, cx))
      .when(!list.length, (el) => el.text_color(t.dim).child("Click to start writing")));
    return out;
  }

  imageBody(tab, t) {
    if (tab.imageError) return div().p(16).text_color(t.dim).child(tab.imageError);
    if (tab.image?.file !== tab.file) return div().p(16).text_color(t.dim).child("Loading…");
    const { path, width, height, bytes } = tab.image, box = this.box;
    const scale = width && height && box ? Math.min(1, (box.width - 32) / width, (box.height - 32) / height) : null;
    const pic = scale ? image(path).flex_none().w(Math.max(1, width * scale)).h(Math.max(1, height * scale)) : image(path).size_full();
    const info = [width && height ? `${width} × ${height}` : null, formatBytes(bytes), scale ? `${Math.round(scale * 100)}%` : null].filter(Boolean).join(" · ");
    return v_flex().flex_1().min_h(0)
      .child(v_flex().id(`image-${tab.id}`).flex_1().min_h(0).overflow_hidden().items_center().justify_center().bg(t.canvas)
        .on_size_change((size, cx) => {
          if (size.width !== this.box?.width || size.height !== this.box?.height) { this.box = size; cx.notify(); }
        })
        .child(pic))
      .child(h_flex().h(26).flex_none().px(12).items_center().justify_end().border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim).child(info));
  }

  body(tab, t) {
    if (isImage(tab.file) && (tab.mode === "preview" || !isSvg(tab.file))) return this.imageBody(tab, t);
    if (tab.error) return div().p(16).text_color(t.dim).child(tab.error);
    if (!tab.state) return div().p(16).text_color(t.dim).child("Loading…");
    if (tab.mode === "preview") {
      return v_flex().id(`preview-${tab.id}`).flex_1().min_h(0).overflow_y_scroll().px(40).py(24).text_size(15).gap(10).children(this.blockViews(tab, t));
    }
    return div().id(`editor-${tab.id}`).flex_1().min_h(0).flex().child(Editor.new(tab.state).flex_1().min_h(0));
  }

  tabItem(tab, idx, activeIdx, labels, t) {
    const active = tab.id === this.active;
    const dirty = Boolean(tab.dirty || tab.pending);
    const hovered = this.hoverTab === tab.id;
    const showTail = active || dirty;
    const { name, hint } = labels.get(tab.id) ?? { name: baseName(tab.file), hint: null };
    const draggingOver = this.pressedTab !== null && this.dragOverTab === idx && this.pressedTab !== idx;
    const stop = (_e, cx) => cx.stop_propagation();

    return h_flex()
      .id(`etab-${tab.id}`)
      .h(26)
      .px(8)
      .gap(5)
      .rounded(6)
      .items_center()
      .flex_none()
      .cursor_pointer()
      .text_size(12)
      .when(idx <= activeIdx, (el) => el.on_size_change((_size, cx) => {
        if (activeIdx >= 0) { this.tabScroll.scroll_to_item(activeIdx); cx.notify(); }
      }))
      .border(1)
      .border_color(draggingOver ? t.accent : active ? t.border : t.background)
      .bg(active ? t.raised : t.background)
      .text_color(active ? t.foreground : t.muted)
      .hover((s) => s.bg(active ? t.raised : t.hover).text_color(t.foreground))
      .tooltip(relPathOf(tab))
      .on_mouse_down("left", (_e, cx) => {
        cx.stop_propagation();
        this.pressedTab = idx;
        this.dragOverTab = idx;
        this.selectTab(tab.id, cx, false);
      })
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        this.finishTabDrag(idx, cx);
      })
      .on_mouse_down("middle", (_e, cx) => {
        cx.stop_propagation();
        cx.spawn((cx) => this.closeTabs([tab.id], cx));
      })
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        this.openTabMenu(tab);
      })
      .on_hover((on, cx) => {
        let changed = false;
        if (on && this.pressedTab !== null && this.dragOverTab !== idx) {
          this.dragOverTab = idx;
          changed = true;
        }
        const nextHover = on ? tab.id : (this.hoverTab === tab.id ? null : this.hoverTab);
        if (nextHover !== this.hoverTab) {
          this.hoverTab = nextHover;
          changed = true;
        }
        if (changed) cx.notify();
      })
      .child(image(iconPath(fileIcon(name))).w(14).h(14).flex_none())
      .child(div().flex_none().max_w(160).truncate().when(active, (el) => el.font_medium()).child(name))
      .when(Boolean(hint), (el) => el.child(div().flex_none().max_w(110).truncate().text_size(11).text_color(t.dim).child(hint)))
      .when(showTail, (el) => el.child(
        div().w(14).h(14).flex_none().flex().items_center().justify_center()
          .when(dirty && !hovered, (d) => d.child(div().size(7).rounded(4).bg(t.accent)))
          .when(!dirty || hovered, (d) => d.child(
            div().id(`etab-close-${tab.id}`).p(1).rounded(4)
              .text_color(dirty ? t.accent : t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_mouse_down("left", stop)
              .on_click((_e, cx) => {
                cx.stop_propagation();
                cx.spawn((cx) => this.closeTabs([tab.id], cx));
              })
              .child(svg("mods/pane/close.svg").size(11)),
          )),
      ));
  }

  render(cx) {
    const pid = this.myPaneId();
    const f = focused();
    if (pid && f?.pane === pid && f?.tab && this.id) {
      const last = shared("mayonaka-editor.last") ?? {};
      if (last[f.tab] !== this.id) setShared("mayonaka-editor.last", { ...last, [f.tab]: this.id });
    }

    const req = shared("mayonaka-editor.open");
    if (req && req.n > this.seen) {
      this.seen = req.n;
      if (this.id && req.id === this.id) this.openFile(req, cx);
    }
    const moved = shared("mayonaka-editor.moved");
    if (moved && moved.n > this.movedSeen) {
      this.movedSeen = moved.n;
      this.follow(moved, cx);
    }
    const deleted = shared("mayonaka-editor.deleted");
    if (deleted && deleted.n > this.deletedSeen) {
      this.deletedSeen = deleted.n;
      this.handleDeleted(deleted, cx);
    }
    const menuReq = shared(MENU_KEY);
    if (menuReq && menuReq.n > this.menuSeen) {
      this.menuSeen = menuReq.n;
      if (menuReq.editor === this.id) this.performMenuAction(menuReq, cx);
    }

    const t = theme();
    const cur = this.currentTab();
    if (!cur) return div().size_full().p(16).bg(t.background).text_color(t.dim).child("No file");
    this.ensureLoaded(cur, cx);
    const activeIdx = this.tabs.findIndex((tab) => tab.id === this.active);
    if (this.active !== this.scrolledActive || activeIdx !== this.scrolledIndex) {
      this.scrolledActive = this.active;
      this.scrolledIndex = activeIdx;
      if (activeIdx >= 0) this.tabScroll.scroll_to_item(activeIdx);
    }
    const labels = tabLabels(this.tabs);
    const showInlinePath = !usesMayonakaPane();

    return v_flex().id("mayonaka-editor").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .on_mouse_up("left", (_e, cx) => {
        if (this.pressedTab !== null) {
          this.pressedTab = null;
          this.dragOverTab = null;
          cx.notify();
        }
      })
      .child(
        h_flex().h(34).flex_none().pr(8).gap(6).items_center().border_b(1).border_color(t.border).text_size(12)
          .on_scroll_wheel((e, cx) => {
            if (Math.abs(e.delta.y) >= 4 && Math.abs(e.delta.x) < 1 && Date.now() - this.wheelAt > 90) {
              this.wheelAt = Date.now();
              this.stepTab(e.delta.y > 0 ? -1 : 1, cx);
            }
          })
          .child(
            h_flex().id("editor-tabs").flex_1().min_w(0).h_full().px(4).gap(2).items_center().overflow_x_scroll()
              .track_scroll(this.tabScroll)
              .on_size_change((_size, cx) => {
                if (activeIdx >= 0) { this.tabScroll.scroll_to_item(activeIdx); cx.notify(); }
              })
              .children(this.tabs.map((tab, idx) => this.tabItem(tab, idx, activeIdx, labels, t))),
          )
          .when(showInlinePath, (el) => el.child(div().max_w(180).truncate().text_size(11).text_color(t.dim).child(relPathOf(cur))))
          .when(hasPreview(cur.file), (el) => el.child(
            h_flex().flex_none().gap(2).p(2).rounded(7).bg(t.surface)
              .child(this.modeToggle(t, cur, "preview", "eye"))
              .child(this.modeToggle(t, cur, "source", "code")),
          )),
      )
      .child(this.body(cur, t));
  }
}
