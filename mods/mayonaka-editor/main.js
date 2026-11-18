// A single-file card editor pane, tiled beside terminals and other file cards by mayonaka-files:
//   pane.split {mod: "mayonaka-editor", direction, pane, props: {id, file, on, root, mode}}
// Each open file lives in its own rounded card pane; mayonaka-pane draws its 30px card header
// (icon, file name, parent relative path, unsaved dot, and preview/source toggle).

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, Textarea, TextareaState } from "gpui-base";
import { splitBlocks, refDefs, replaceBlock, appendBlock, itemMarkdown, itemNumbers } from "./blocks.js";
import { tokenize, blockMode, diff, continueLine, parseMarker, toggleTask } from "./inline.js";
import { imageSize, formatBytes } from "./image.js";
import { fileIcon, iconPath } from "./material.js";
import { BinaryFileError, readEditorFile, writeEditorText } from "./remote.js";
import {
  props, shared, setShared, watchFolder, exec, notify, nextCommand,
  theme, settings, appHome, spaces, panes, focused, layout, run,
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
const CLOSED_KEY = "mayonaka-editor.closed";
const LARGE_MD = 256 * 1024;
const FOLD_MAX = 512 * 1024;
const MEDIUM_MAX = 2 * 1024 * 1024;
const LONG_LINE = 10000;
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
    this.handle = cx.focus_handle();
    this.id = p.id ?? `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.file = null;
    this.on = null;
    this.root = null;
    this.mode = "source";
    this.state = null;
    this.stateSyntax = null;
    this.original = null;
    this.digest = null;
    this.dirty = false;
    this.pending = false;
    this.saving = false;
    this.edit = null;
    this.parsed = null;
    this.moved = null;
    this.error = null;
    this.lastError = null;
    this.image = null;
    this.imageError = null;
    this.box = null;
    this.autosave = null;
    this.dirtyCheck = null;
    this.discardUntil = 0;
    this.watchHandle = null;
    this.watchGen = 0;
    this.watchKey = null;
    this.seq = 0;
    this.syncing = null;
    this.pendingVerifyChanges = 0;
    this.closed = false;

    this.seen = shared("mayonaka-editor.open")?.n ?? 0;
    this.movedSeen = shared("mayonaka-editor.moved")?.n ?? 0;
    this.deletedSeen = shared("mayonaka-editor.deleted")?.n ?? 0;

    // Restore persisted file state (only when this id belonged to a live pane; otherwise prefer fresh props).
    const liveEids = new Set();
    const livePaneSet = new Set(panes().filter((pn) => pn.mod === "mayonaka-editor").map((pn) => pn.pane));
    for (const [pn, eid] of Object.entries(shared("mayonaka-editor.ids") ?? {})) {
      if (livePaneSet.has(pn)) liveEids.add(eid);
    }
    const rawSaved = (this.id && (liveEids.has(this.id) || !p.file)) ? shared("mayonaka-editor.files")?.[this.id] : null;
    const saved = Array.isArray(rawSaved?.tabs) && rawSaved.tabs.length > 0
      ? (rawSaved.tabs.find((t) => t.id === rawSaved.active) ?? rawSaved.tabs[0])
      : rawSaved;
    const initial = saved?.file ? saved : (p.file ? p : null);
    if (initial?.file) {
      this.open(initial, cx);
    } else {
      this.syncShared();
    }

    this.sweepStaleImageCache();

    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (this.closed) return;
        if (cmd === "focus") {
          this.handle.focus();
          cx.notify();
          continue;
        }
        if (cmd === "autosave-on" || cmd === "autosave-off") {
          const on = cmd === "autosave-on";
          setShared(AUTOSAVE, on);
          if (on) {
            if (this.dirty || this.pending) this.scheduleSave(cx);
          } else {
            this.cancelTimers();
          }
          cx.notify();
          continue;
        }
        const target = this.matchCommandTarget();
        if (!target) continue;
        if (cmd === "save") {
          this.commit(true);
          this.save(cx, true);
        } else if (cmd === "toggle" && hasPreview(this.file)) {
          this.setMode(this.mode === "preview" ? "source" : "preview", cx);
        } else if (cmd === "set-mode" && hasPreview(this.file)) {
          const want = target.mode === "preview" ? "preview" : "source";
          this.setMode(want, cx);
        } else if (cmd === "close-pane") {
          await this.closePane(cx, { remember: true });
        }
        cx.notify();
      }
    });
  }

  close() {
    this.closed = true;
    this.cancelTimers();
    this.watchHandle?.cancel();
    this.watchHandle = null;
    if (this.edit?.ta) { this.edit.ta.release(); this.edit = null; }
    this.state?.release(); this.state = null;
    this.dropImage();
  }

  myPaneId() {
    if (!this.id) return null;
    const edPanes = panes().filter((p) => p.mod === "mayonaka-editor");
    const liveSet = new Set(edPanes.map((p) => p.pane));
    const rawIds = shared("mayonaka-editor.ids") ?? {};
    const ids = {};
    let stale = false;
    for (const [pane, eid] of Object.entries(rawIds)) {
      if (liveSet.has(pane)) ids[pane] = eid;
      else stale = true;
    }
    for (const [pane, eid] of Object.entries(ids)) {
      if (eid === this.id) {
        if (stale) setShared("mayonaka-editor.ids", ids);
        return pane;
      }
    }
    const unclaimed = edPanes.filter((p) => !ids[p.pane]);
    if (unclaimed.length === 1) {
      const pane = unclaimed[0].pane;
      setShared("mayonaka-editor.ids", { ...ids, [pane]: this.id });
      return pane;
    }
    if (stale) setShared("mayonaka-editor.ids", ids);
    return null;
  }

  // Matches explicit palette/header targets first, otherwise checks focused pane or active tab's last editor.
  matchCommandTarget() {
    const explicit = shared("mayonaka-editor.target");
    if (explicit && Date.now() - (explicit.n ?? 0) < 2500 && explicit.id) {
      return explicit.id === this.id ? explicit : null;
    }
    const pid = this.myPaneId();
    const f = focused();
    if (pid && f?.pane === pid) return { id: this.id };
    const editors = panes().filter((p) => p.tab === f?.tab && p.mod === "mayonaka-editor");
    if (editors.length === 1 && pid && editors[0].pane === pid) return { id: this.id };
    const lastId = f?.tab ? (shared("mayonaka-editor.last") ?? {})[f.tab] : null;
    if (lastId && lastId === this.id) return { id: this.id };
    return null;
  }

  async sweepStaleImageCache() {
    try {
      const dir = `${appHome()}/${CACHE}`;
      const entries = await readdir(dir).catch(() => []);
      const liveIds = new Set(Object.values(shared("mayonaka-editor.ids") ?? {}));
      if (this.id) liveIds.add(this.id);
      for (const name of entries) {
        if (name === "save" || !name.includes("-")) continue;
        const owner = name.slice(0, name.indexOf("-"));
        if (owner && !liveIds.has(owner)) {
          unlink(`${dir}/${name}`).catch(() => {});
        }
      }
    } catch {}
  }

  cancelTimers() {
    this.autosave?.cancel(); this.autosave = null;
    this.dirtyCheck?.cancel(); this.dirtyCheck = null;
  }

  syncShared() {
    if (!this.id) return;
    const prevMap = shared("mayonaka-editor.files") ?? {};
    const entry = {
      file: this.file,
      on: this.on ?? null,
      root: this.root ?? null,
      mode: this.mode,
      dirty: Boolean(this.dirty || this.pending),
      hasPreview: hasPreview(this.file),
    };
    const old = prevMap[this.id];
    if (old && JSON.stringify(old) === JSON.stringify(entry)) return;
    setShared("mayonaka-editor.files", { ...prevMap, [this.id]: entry });
  }

  setMode(want, cx) {
    if (this.mode === want) return;
    this.commit(false);
    this.mode = want;
    if (want === "source" && isSvg(this.file) && !this.state) this.load(cx);
    this.syncShared();
    cx.notify();
  }

  open({ file, on = null, root = null, mode = null }, cx) {
    if (!file) return;
    this.commit(false);
    this.cancelTimers();
    this.dropImage();
    this.file = file;
    this.on = on ?? null;
    this.root = root ?? this.root ?? null;
    this.mode = mode === "preview" || mode === "source" ? mode : (hasPreview(file) ? "preview" : "source");
    this.original = null;
    this.digest = null;
    this.dirty = false;
    this.pending = false;
    this.error = null;
    this.lastError = null;
    this.parsed = null;
    this.moved = null;
    this.discardUntil = 0;
    this.syncing = null;
    this.pendingVerifyChanges = 0;
    this.syncShared();
    this.load(cx);
    this.ensureWatch(cx);
    cx.notify();
  }

  ensureWatch(cx) {
    const key = (!this.on && this.file) ? dirname(this.file) : null;
    if (key === this.watchKey) return;
    this.watchHandle?.cancel();
    this.watchHandle = null;
    this.watchKey = key;
    const gen = ++this.watchGen;
    if (!key) return;
    cx.spawn(async (cx) => {
      try {
        for (;;) {
          const watch = watchFolder(key);
          this.watchHandle = watch;
          const changed = await watch;
          if (this.watchHandle === watch) this.watchHandle = null;
          if (this.closed || this.watchGen !== gen) return;
          while (!this.closed && this.watchGen === gen && this.saving) await cx.sleep(20);
          if (this.closed || this.watchGen !== gen) return;
          if (!this.dirty && !this.saving && !this.edit && !this.pending && this.file) {
            if (changed.includes(key) || changed.includes(this.file)) this.load(cx);
          }
        }
      } catch {}
    });
  }

  rememberClosed() {
    if (!this.file) return;
    const list = Array.isArray(shared(CLOSED_KEY)) ? [...shared(CLOSED_KEY)] : [];
    const filtered = list.filter((c) => !(c.file === this.file && (c.on ?? null) === (this.on ?? null)));
    filtered.push({ file: this.file, on: this.on ?? null, root: this.root ?? null, mode: this.mode });
    while (filtered.length > MAX_CLOSED_HISTORY) filtered.shift();
    setShared(CLOSED_KEY, filtered);
  }

  cleanupRegistryAndClose() {
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

  async closePane(cx, { remember = true } = {}) {
    this.commit(false);
    while (!this.closed && this.saving) await cx.sleep(20);
    if (this.closed) return;
    if (this.dirty && this.state && this.original !== null) {
      this.dirty = this.state.value() !== this.original;
    }
    if (shared(AUTOSAVE) !== false && (this.dirty || this.pending) && !this.lastError && this.original !== null) {
      await this.save(cx, false);
    }
    if (this.dirty || this.pending || this.saving) {
      const now = Date.now();
      if (now >= this.discardUntil) {
        this.discardUntil = now + DISCARD_WINDOW_MS;
        this.syncShared();
        notify({
          title: "Unsaved changes",
          body: `${baseName(this.file)} has unsaved edits. Save with ⌘S, or repeat to discard.`,
          level: "warning",
        });
        return;
      }
    }
    if (remember) this.rememberClosed();
    this.cleanupRegistryAndClose();
  }

  // mayonaka-files moved or renamed a file or folder. Follow it in place with unsaved edits intact.
  follow({ from, to, on = null }, cx) {
    if (!this.file || !from || !to || (this.on ?? null) !== (on ?? null)) return;
    const nextFile = this.file === from ? to : this.file.startsWith(from + "/") ? to + this.file.slice(from.length) : null;
    if (!nextFile) return;
    this.file = nextFile;
    if (this.image) this.image.file = nextFile;
    this.error = null;
    this.syncShared();
    this.ensureWatch(cx);
    this.load(cx);
    cx.notify();
  }

  // mayonaka-files deleted a file or folder. Clean cards close; dirty cards stay open without resurrecting via auto save.
  handleDeleted({ path, dir, on = null }, cx) {
    if (!this.file || !path || (this.on ?? null) !== (on ?? null)) return;
    const hit = this.file === path || (dir && this.file.startsWith(path + "/"));
    if (!hit) return;
    this.commit(false);
    if (this.dirty && this.state && this.original !== null) {
      this.dirty = this.state.value() !== this.original;
    }
    if (!this.dirty && !this.pending && !this.saving) {
      this.cleanupRegistryAndClose();
    } else {
      this.cancelTimers();
      this.original = null;
      this.digest = null;
      this.dirty = true;
      this.syncShared();
      cx.notify();
    }
  }

  load(cx) {
    const file = this.file;
    if (!file) return;
    if (isImage(file)) {
      this.loadImage(cx);
      if (!isSvg(file)) return;
    }
    const seq = ++this.seq;
    cx.spawn(async (cx) => {
      try {
        const clean = Boolean(this.state && !this.dirty && !this.saving && !this.edit && !this.pending);
        const res = await readEditorFile(file, this.on, clean ? this.digest : null);
        if (this.closed || seq !== this.seq || this.file !== file) return;
        if (res.status === "missing") {
          if (!this.state || (!this.dirty && !this.saving && !this.edit && !this.pending)) {
            this.error = "This file is no longer available";
          }
          cx.notify();
          return;
        }
        if (res.status === "unchanged") {
          if (this.error) { this.error = null; cx.notify(); }
          return;
        }
        const { text, digest } = res;
        if (this.state && (this.dirty || this.saving || this.edit || this.pending)) return;
        const bytes = digest?.bytes ?? Buffer.byteLength(text, "utf8");
        this.digest = digest;
        if (this.original === null && isMarkdown(file) && bytes > LARGE_MD && this.mode === "preview") {
          this.mode = "source";
        }
        const firstOpen = this.original === null;
        this.error = null;
        this.lastError = null;
        if (firstOpen || !this.state) {
          this.original = text;
          this.dirty = false;
          this.buildEditor(text);
        } else if (text !== this.original) {
          this.original = text;
          this.dirty = false;
          this.setEditorValue(text);
        } else {
          this.dirty = false;
        }
        this.syncShared();
      } catch (e) {
        if (this.closed || seq !== this.seq || this.file !== file) return;
        const m = String(e?.message ?? e);
        this.error = e instanceof BinaryFileError ? "Binary file — cannot display as text."
          : /too large|exceeds maximum/i.test(m) ? "File too large to open (over 8 MiB)." : m;
      }
      cx.notify();
    });
  }

  dropImage() {
    const f = this.image?.disk;
    this.image = null;
    this.imageError = null;
    if (f) unlink(f).catch(() => {});
  }

  loadImage(cx) {
    const file = this.file, on = this.on;
    this.imageError = null;
    cx.spawn(async (cx) => {
      let disk = null;
      try {
        const buf = await this.readBytes(file, on);
        if (this.closed || this.file !== file) return;
        const ext = (file.split(".").pop() ?? "img").toLowerCase().replace(/[^a-z0-9]/g, "") || "img";
        const hash = createHash("sha1").update(buf).digest("hex").slice(0, 12);
        const dir = `${appHome()}/${CACHE}`;
        await mkdir(dir, { recursive: true });
        const rel = `${CACHE}/${this.id}-${hash}.${ext}`;
        disk = `${appHome()}/${rel}`;
        await writeFile(disk, buf);
        if (this.closed || this.file !== file) { unlink(disk).catch(() => {}); return; }
        const old = this.image?.disk;
        if (old && old !== disk) unlink(old).catch(() => {});
        const dim = imageSize(buf, ext);
        this.image = { file, path: rel, disk, bytes: buf.length, width: dim?.width ?? null, height: dim?.height ?? null };
      } catch (e) {
        if (disk) unlink(disk).catch(() => {});
        if (this.file === file) this.imageError = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  async readBytes(file, on) {
    if (!on) {
      try {
        const b = await readFile(file);
        if (b.length > MAX_IMAGE) throw new Error("Image too large to preview (over 32 MiB).");
        return b;
      } catch (e) {
        if (!/outside|home|perm|acces/i.test(String(e?.message ?? e))) throw e;
      }
    }
    const max = on ? MAX_REMOTE_IMAGE : MAX_IMAGE;
    const q = "'" + file.replace(/'/g, "'\\''") + "'";
    const r = await exec("sh", ["-c", `s=$(wc -c < ${q}) || exit 1; [ "$s" -le ${max} ] || { echo "too large" >&2; exit 2; }; base64 < ${q}`], { on: on ?? undefined, timeout: 20000 });
    if (r.code === 2) throw new Error(`Image too large to preview (over ${on ? 6 : 32} MiB).`);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || "Could not read image").trim());
    return Buffer.from(r.stdout.replace(/\s+/g, ""), "base64");
  }

  // Guards programmatic set_value calls whether the host fires "change" synchronously, on a later turn, or not at all.
  setEditorValue(text) {
    if (!this.state) return;
    let firedSync = false;
    this.syncing = () => { firedSync = true; };
    try { this.state.set_value(text); }
    finally { this.syncing = null; }
    if (!firedSync) this.pendingVerifyChanges = (this.pendingVerifyChanges ?? 0) + 1;
    this.parsed = null;
    this.moved = null;
  }

  syntaxColors(t) {
    return {
      keyword: t.ansi5, string: t.ansi2, "string.escape": t.ansi6, comment: t.dim,
      function: t.ansi4, type: t.ansi3, number: t.ansi3, constant: t.ansi3,
      boolean: t.ansi3, variable: t.ansi1, operator: t.ansi6, punctuation: t.muted,
    };
  }

  buildEditor(text) {
    this.state?.release();
    this.syncing = null;
    this.pendingVerifyChanges = 0;
    const ext = (this.file.split(".").pop() ?? "").toLowerCase();
    const s = settings(), t = theme();
    const bytes = this.digest?.bytes ?? Buffer.byteLength(text, "utf8");
    const plain = hasLongLine(text);
    const language = plain ? undefined : (LANG[ext] ?? ext);
    const syntax = plain ? undefined : this.syntaxColors(t);
    this.stateSyntax = syntax ? JSON.stringify(syntax) : "";
    const state = EditorState.new({
      value: text,
      language,
      folding: bytes <= FOLD_MAX && !plain,
      font_family: s.font_family,
      font_size: Math.round(s.font_size),
      soft_wrap: isMarkdown(this.file),
      syntax,
    });
    state.on("change", (_e, cx) => {
      if (this.state !== state) return;
      if (this.syncing) { this.syncing(); return; }
      if (this.pendingVerifyChanges > 0) {
        this.pendingVerifyChanges--;
        const dirty = this.original === null || state.value() !== this.original;
        if (dirty !== this.dirty) {
          this.dirty = dirty;
          this.syncShared();
          cx.notify();
        }
        if (dirty) this.touch(cx);
        return;
      }
      this.parsed = null;
      this.moved = null;
      if (!this.dirty) {
        this.dirty = true;
        this.syncShared();
        cx.notify();
      }
      this.touch(cx);
    });
    this.state = state;
    this.parsed = null;
    this.moved = null;
  }

  autosaveDelay() {
    const bytes = this.digest?.bytes ?? (this.original ? this.original.length : 0);
    if (bytes > MEDIUM_MAX) return AUTOSAVE_LARGE_MS;
    if (bytes > LARGE_MD) return AUTOSAVE_MEDIUM_MS;
    return AUTOSAVE_SMALL_MS;
  }

  scheduleSave(cx) {
    this.autosave?.cancel();
    if (shared(AUTOSAVE) === false || this.original === null) { this.autosave = null; return; }
    this.autosave = cx.timer.after(this.autosaveDelay(), (cx) => {
      this.autosave = null;
      cx.spawn((cx) => this.save(cx, false));
    });
  }

  scheduleDirtyCheck(cx) {
    this.dirtyCheck?.cancel();
    this.dirtyCheck = cx.timer.after(DIRTY_CHECK_MS, (cx) => {
      this.dirtyCheck = null;
      if (!this.state || this.edit || this.original === null) return;
      const nowDirty = this.state.value() !== this.original;
      if (nowDirty !== this.dirty) {
        this.dirty = nowDirty;
        this.syncShared();
        cx.notify();
      }
    });
  }

  touch(cx) {
    if (shared(AUTOSAVE) === false) this.scheduleDirtyCheck(cx);
    else this.scheduleSave(cx);
  }

  async save(cx, loud = true) {
    this.autosave?.cancel(); this.autosave = null;
    this.dirtyCheck?.cancel(); this.dirtyCheck = null;
    if (!loud && this.edit) this.commit(true);
    if (!this.file || !this.state || (!loud && this.original === null)) return;
    if (this.saving) {
      if (!loud) {
        this.scheduleSave(cx);
        return;
      }
      const startFile = this.file, startState = this.state;
      while (!this.closed && this.saving) await cx.sleep(20);
      if (this.closed || this.file !== startFile || this.state !== startState) return;
    }
    const text = this.state.value();
    if (this.original !== null && text === this.original) {
      this.lastError = null;
      if (this.dirty) { this.dirty = false; this.syncShared(); cx.notify(); }
      return;
    }
    this.saving = true;
    const file = this.file, expected = this.original, prevDigest = this.digest;
    try {
      const nextDigest = await writeEditorText(file, text, expected, this.on, this.id, prevDigest);
      if (this.file === file && this.original === expected) {
        this.original = text;
        this.digest = nextDigest;
        this.lastError = null;
        this.dirty = this.state.value() !== text;
        this.syncShared();
        if (this.dirty || this.pending) this.scheduleSave(cx);
        if (isSvg(file) && this.mode === "preview") this.loadImage(cx);
      }
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (loud || msg !== this.lastError) notify({ title: "Not saved", body: msg, level: "error" });
      this.lastError = msg;
    } finally {
      this.saving = false;
    }
    cx.notify();
  }

  link(url, cx) {
    if (!url || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#")) return;
    const target = resolve(this.file, url.split("#")[0]);
    if (target === this.file) return;
    const f = focused();
    const tabId = f?.tab ?? spaces().find((s) => s.active)?.tabs?.find((t) => t.active)?.id;
    const ids = shared("mayonaka-editor.ids") ?? {};
    const filesMap = shared("mayonaka-editor.files") ?? {};
    const tabEditors = panes().filter((p) => p.tab === tabId && p.mod === "mayonaka-editor" && ids[p.pane]);
    const existing = tabEditors.find((p) => {
      const info = filesMap[ids[p.pane]];
      return info?.file === target && (info.on ?? null) === (this.on ?? null);
    });
    if (existing) {
      run("pane.focus", { pane: existing.pane });
      return;
    }
    const myPane = this.myPaneId();
    const id = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    run("pane.split", {
      direction: "down",
      ...(myPane ? { pane: myPane } : {}),
      mod: "mayonaka-editor",
      props: { id, file: target, on: this.on, root: this.root },
    });
    cx.spawn(async () => {
      await cx.sleep(60);
      const ps = panes().filter((p) => p.tab === tabId && p.mod === "mayonaka-editor");
      const curIds = shared("mayonaka-editor.ids") ?? {};
      const fresh = ps.find((p) => !curIds[p.pane]);
      if (fresh) setShared("mayonaka-editor.ids", { ...curIds, [fresh.pane]: id });
    });
  }

  blocks() {
    const text = this.state.value();
    if (this.parsed?.text !== text) {
      const list = splitBlocks(text);
      this.parsed = { text, list, refs: refDefs(list) };
    }
    return this.parsed;
  }

  edit_block(b, cx) {
    if (this.edit?.ta && this.edit.start === b.start && this.edit.src === b.src) return;
    const before = this.parsed;
    this.commit(false);
    let { start, end } = b;
    if (this.moved && this.moved.from === before && start >= this.moved.at) { start += this.moved.delta; end += this.moved.delta; }
    const doc = this.state.value();
    if (b.append) start = end = doc.length;
    else if (doc.slice(start, end) !== b.src) { cx.notify(); return; }
    const ta = TextareaState.new({ value: b.src });
    ta.set_auto_grow(1, 1000);
    ta.set_value({ text: b.src, tokens: tokenize(b.src) });
    ta.on("change", (_e, cx) => {
      if (this.edit?.ta === ta) {
        this.restyle(this.edit);
        this.syncShared();
        this.touch(cx);
        cx.notify();
      }
    });
    this.edit = { ta, start, end, src: b.src, append: Boolean(b.append), prev: b.src, open: null, indent: b.indent ?? 0 };
    this.pending = false;
    cx.spawn(async (cx) => { await cx.sleep(0); if (this.edit?.ta === ta) ta.focus(); });
    cx.notify();
  }

  restyle(e) {
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
      this.pending = e.prev !== e.src;
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
    this.pending = e.prev !== e.src;
  }

  token_click(ev, cx) {
    const e = this.edit;
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

  token_view(ctx, t) {
    const s = ctx.token.text;
    switch (ctx.token.id) {
      case "marker": {
        const m = parseMarker(s), parts = [];
        for (let q = 0; q < m.quotes; q++) parts.push(div().w(3).h(ctx.line_height).rounded(2).bg(t.border));
        if (m.heading) parts.push(div().text_size(10).text_color(t.dim).child("H" + m.heading));
        if (m.bullet) parts.push(div().pl(Math.max(0, m.indent - (this.edit?.indent ?? 0)) * 7).text_color(t.dim).child(/\d/.test(m.bullet) ? m.bullet : "•"));
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

  commit(keep = false) {
    const e = this.edit;
    if (!e || !this.state) return;
    const text = this.state.value(), next = e.ta.value(), from = this.parsed;
    if (next !== e.src) {
      let updated = text;
      if (e.append) {
        if (next.trim()) {
          const r = appendBlock(text, next);
          updated = r.text;
          this.setEditorValue(updated);
          Object.assign(e, { start: r.start, end: r.end, src: updated.slice(r.start, r.end), append: false });
        }
      } else {
        const r = replaceBlock(text, e.start, e.end, next);
        updated = r.text;
        this.setEditorValue(updated);
        this.moved = { from, at: r.at, delta: r.delta };
        Object.assign(e, { end: e.start + next.length, src: next });
      }
      this.dirty = this.original === null || updated !== this.original;
    }
    this.pending = false;
    if (keep) return;
    this.edit = null;
    e.ta.release();
    this.syncShared();
  }

  block_textarea(e, t) {
    const text = e.ta.value(), mode = blockMode(text), first = parseMarker(text);
    const area = Textarea.new(e.ta).w_full()
      .token((ctx) => this.token_view(ctx, t))
      .on_token_click((ev, cx) => this.token_click(ev, cx));
    if (mode !== "rich") return area.font_family(settings().font_family).text_size(13);
    if (first.heading) return area.font_bold().text_size(HEADING[first.heading]);
    return area.when(first.quotes > 0, (el) => el.text_color(t.muted));
  }

  blockViews(t) {
    const { list, refs } = this.blocks(), e = this.edit, out = [];
    const tail = (b) => (refs && b.kind !== "code" ? "\n\n" + refs : "");
    const md = (b) => (b.kind === "front" ? "```yaml\n" + b.src.replace(/^---\r?\n|\r?\n---$/g, "") + "\n```" : b.src) + tail(b);
    const editor = (depth = 0) => div().id("block-edit").w_full().pl(8 + depth * 24).pr(8).mx(-8).py(2).rounded(6).border(1).border_color(t.border)
      .on_key_down((ev, cx) => { if (ev.keystroke === "escape") { this.commit(false); cx.notify(); } })
      .on_mouse_down_out((ev, cx) => { if (ev.position.x < 0 || ev.position.y < 0) return; this.commit(false); cx.notify(); })
      .child(this.block_textarea(e, t));
    const view = (id, u, source, depth = 0) => div().id(id).w_full().pl(8 + depth * 24).pr(8).mx(-8).rounded(6).cursor_text()
      .hover((s) => s.bg(t.surface))
      .on_click((_ev, cx) => this.edit_block(u, cx))
      .child(TextView.markdown(`md-${this.file}-${id}`, source).on_link_click((url, cx) => { cx.stop_propagation(); this.link(url, cx); }));
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
        out.push(v_flex().id(`list-${i}`).w_full().gap(loose ? 8 : 0).children(rows));
        return;
      }
      if (editing(b)) { if (!shown) { out.push(editor()); shown = true; } return; }
      if (before(b)) { out.push(editor()); shown = true; }
      out.push(view(`block-${i}`, b, md(b)).when(b.kind === "heading" && i > 0, (el) => el.mt(14)));
    });
    if (e && !shown) out.push(editor());
    if (!e?.append) out.push(div().id("block-append").w_full().min_h(48).flex_1().cursor_text()
      .on_click((_ev, cx) => this.edit_block({ append: true, start: 0, end: 0, src: "", kind: "paragraph" }, cx))
      .when(!list.length, (el) => el.text_color(t.dim).child("Click to start writing")));
    return out;
  }

  imageBody(t) {
    if (this.imageError) return div().p(16).text_color(t.dim).child(this.imageError);
    if (this.image?.file !== this.file) return div().p(16).text_color(t.dim).child("Loading…");
    const { path, width, height, bytes } = this.image, box = this.box;
    const scale = width && height && box ? Math.min(1, (box.width - 32) / width, (box.height - 32) / height) : null;
    const pic = scale ? image(path).flex_none().w(Math.max(1, width * scale)).h(Math.max(1, height * scale)) : image(path).size_full();
    const info = [width && height ? `${width} × ${height}` : null, formatBytes(bytes), scale ? `${Math.round(scale * 100)}%` : null].filter(Boolean).join(" · ");
    return v_flex().flex_1().min_h(0)
      .child(v_flex().id("image-view").flex_1().min_h(0).overflow_hidden().items_center().justify_center().bg(t.canvas)
        .on_size_change((size, cx) => {
          if (size.width !== this.box?.width || size.height !== this.box?.height) { this.box = size; cx.notify(); }
        })
        .child(pic))
      .child(h_flex().h(26).flex_none().px(12).items_center().justify_end().border_t(1).border_color(t.border).text_size(11.5).text_color(t.dim).child(info));
  }

  body(t) {
    if (isImage(this.file) && (this.mode === "preview" || !isSvg(this.file))) return this.imageBody(t);
    if (this.error) return div().p(16).text_color(t.dim).child(this.error);
    if (!this.state) return div().p(16).text_color(t.dim).child("Loading…");
    if (this.mode === "preview") {
      return v_flex().id("preview").flex_1().min_h(0).overflow_y_scroll().px(40).py(24).text_size(15).gap(10).children(this.blockViews(t));
    }
    return div().id("editor").flex_1().min_h(0).flex().child(Editor.new(this.state).flex_1().min_h(0));
  }

  fallbackHeader(t) {
    const rel = this.root && this.file.startsWith(this.root + "/") ? this.file.slice(this.root.length + 1) : this.file;
    const name = baseName(this.file);
    const toggle = (which, iconName) => div()
      .id(`mode-${which}`)
      .size(22)
      .flex()
      .items_center()
      .justify_center()
      .rounded(5)
      .cursor_pointer()
      .bg(this.mode === which ? t.selected : t.surface)
      .text_color(this.mode === which ? t.foreground : t.muted)
      .hover((s) => s.bg(this.mode === which ? t.selected : t.hover).text_color(t.foreground))
      .on_click((_e, cx) => this.setMode(which, cx))
      .child(svg(`mods/mayonaka-editor/${iconName}.svg`).size(13));

    return h_flex().h(34).flex_none().px(10).gap(7).items_center().border_b(1).border_color(t.border).text_size(12)
      .child(image(iconPath(fileIcon(name))).w(14).h(14).flex_none())
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(rel))
      .when(Boolean(this.dirty || this.pending), (el) => el.child(div().size(7).flex_none().rounded(4).bg(t.accent)))
      .when(hasPreview(this.file), (el) => el.child(
        h_flex().flex_none().gap(2).p(2).rounded(6).bg(t.surface)
          .child(toggle("preview", "eye"))
          .child(toggle("source", "code")),
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
      if (this.id && req.id === this.id) this.open(req, cx);
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

    const t = theme();
    // Re-sync syntax colors if theme changed between dark and light.
    if (this.state && this.stateSyntax) {
      const wantSyntax = JSON.stringify(this.syntaxColors(t));
      if (wantSyntax !== this.stateSyntax) this.buildEditor(this.state.value());
    }

    if (!this.file) {
      return div().id("mayonaka-editor-empty").track_focus(this.handle).size_full().p(16).bg(t.background).text_color(t.dim).child("No file");
    }

    return v_flex().id("mayonaka-editor").track_focus(this.handle).size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .when(!usesMayonakaPane(), (el) => el.child(this.fallbackHeader(t)))
      .child(this.body(t));
  }
}
