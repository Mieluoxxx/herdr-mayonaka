// Native GPUI main-workspace chat view for Mizar in Mayonaka.
// Directly spawns & manages its own `mizar rpc` process over 127.0.0.1 loopback TCP,
// drawing Mizar's native minimalist transcript, pi-emphasis pills, colored unified diffs,
// inline slash/mention/shell interactions, and 1-line bottom status bar.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, Textarea, TextareaState, ScrollHandle } from "gpui-base";
import {
  home, appHome, exec, checking, spaces, panes, focused, props, theme,
  shared, setShared, window as win, notify, nextCommand,
} from "herdr";
import * as fs from "fs/promises";
import net from "net";
import {
  scanRunDir, MizarRpcClient, createSessionState, applySnapshot,
  applyNotification, prependPagedEvents, summarizeCommittedEvent,
} from "./rpc.js";
import { splitMarkdownWithPills } from "./emphasis.js";
import { parseUnifiedDiff } from "./diff.js";
import {
  buildLaunchCommand, waitForReadyFile, resolveWorkspaceFiles,
  parseComposerCommand, detectActiveCompletion, filterFileCandidates,
} from "./launcher.js";

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const IDS_KEY = "mayonaka-mizar.ids";
const PANES_KEY = "mayonaka-mizar.panes";
const MOD_ICON = "mods/mayonaka-mizar/mizar.svg";
const SPINNER_ICON = "mods/workspace-chrome/spinner.svg";

const BUILTIN_SLASH_META = [
  { command: "model", description: "Switch model / provider", takes_arg: true },
  { command: "effort", description: "Adjust reasoning effort (off..max)", takes_arg: true },
  { command: "resume", description: "Switch to another workspace session", takes_arg: true },
  { command: "new", description: "Start a fresh session", takes_arg: true },
  { command: "compact", description: "Compact session context", takes_arg: true },
  { command: "tree", description: "Inspect session tree and fork points", takes_arg: false },
  { command: "fork", description: "Fork session at sequence number", takes_arg: true },
  { command: "approve", description: "Toggle approval mode (auto / ask)", takes_arg: true },
  { command: "help", description: "Show commands and shortcuts", takes_arg: false },
];

function runDirPath() {
  return `${home()}/.mizar/run`;
}

function cacheDirPath() {
  return `${appHome()}/cache/mayonaka-mizar`;
}

function storageKeyForInstance(id) {
  return `mayonaka-mizar.inst.${id}`;
}

function fmtTokens(n) {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v) || v <= 0) return "0";
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function truncateText(s, max = 320) {
  if (typeof s !== "string") return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function shortHome(p) {
  if (!p) return "";
  const h = home();
  return p === h ? "~" : p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

function withAlpha(hex, alphaHex = "22", fallback = "#282c34") {
  return typeof hex === "string" && /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}${alphaHex}` : fallback;
}

function pillPalette(t, tone) {
  if (tone === "success") return { fg: t.done, bg: withAlpha(t.done, "24", t.surface), bd: withAlpha(t.done, "66", t.border) };
  if (tone === "error") return { fg: t.blocked, bg: withAlpha(t.blocked, "24", t.surface), bd: withAlpha(t.blocked, "66", t.border) };
  if (tone === "danger") return { fg: t.blocked, bg: withAlpha(t.blocked, "33", t.raised), bd: t.blocked };
  if (tone === "warning") return { fg: t.working, bg: withAlpha(t.working, "24", t.surface), bd: withAlpha(t.working, "66", t.border) };
  if (tone === "mode") return { fg: t.accent, bg: withAlpha(t.accent, "24", t.selected), bd: withAlpha(t.accent, "66", t.accent) };
  if (tone === "owner") return { fg: t.ansi5 ?? t.accent, bg: withAlpha(t.ansi5 ?? t.accent, "22", t.surface), bd: t.border };
  return { fg: t.muted, bg: t.surface, bd: t.border };
}

function flattenAssistantBlocks(blocks) {
  const reasoningParts = [];
  const textParts = [];
  const toolCalls = [];
  for (const b of blocks ?? []) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "reasoning" && b.text) reasoningParts.push(b.text);
    else if (b.type === "text" && b.text) textParts.push(b.text);
    else if (b.type === "tool-call" || b.kind === "tool-call") toolCalls.push(b);
  }
  return {
    reasoning: reasoningParts.join("\n\n"),
    text: textParts.join("\n\n"),
    toolCalls,
  };
}

function resolveInitialWorkspace(p) {
  if (p?.cwd) return p.cwd;
  const f = focused();
  const allPanes = panes();
  const fp = f?.pane ? allPanes.find((x) => x.pane === f.pane) : null;
  if (fp?.cwd) return fp.cwd;
  if (f?.cwd) return f.cwd;
  const sp = spaces().find((s) => s.active);
  return sp?.folder || home();
}

export default class MizarView extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.composer = TextareaState.new({
      placeholder: "Message Mizar… (/ commands · @ files · ! shell · Enter sends)",
      value: "",
      rows: 2,
    });
    this.composer.set_auto_grow(2, 6);
    this.composer.set_soft_wrap(true);

    this.id = p.id ?? `mz${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.cwd = resolveInitialWorkspace(p);
    this.boundPane = null;
    this.closed = false;
    this.draft = "";
    this.composerFocused = false;
    this.runningBash = false;

    this.managedPid = null;
    this.ownedPid = null;
    this.attachOnlyPid = p.pid ?? null;
    this.client = null;
    this.launching = false;
    this.error = null;
    this.flash = null;

    this.sessionState = createSessionState();
    this.capabilities = null;
    this.workspaceFiles = [];
    this.historyItems = [];
    this.treeEntries = [];
    this.picker = null; // null | "models" | "resume" | "tree" | "effort" | "help"
    this.compIdx = 0;
    this.expandedReasoning = new Set();
    this.toggledTools = new Map();
    this.loadingHistory = false;
    this.healthTimer = null;

    this.composer.on("change", (_e, cx) => {
      this.draft = this.composer.value();
      this.compIdx = 0;
      cx.notify();
    });
    this.composer.on("focus", (_e, cx) => {
      this.composerFocused = true;
      cx.notify();
    });
    this.composer.on("blur", (_e, cx) => {
      this.composerFocused = false;
      cx.notify();
    });
    this.composer.on("submit", (e, cx) => {
      if (e?.shift) return;
      const steer = Boolean(e?.alt || e?.modifiers?.alt);
      this.submitComposer(cx, { steer });
    });

    if (!checking()) {
      this.myPaneId();
      this.publishStatus();
      this.launchOrAttach(cx);
      this.startCommandLoop(cx);
      this.healthTimer = cx.timer.every(3000, (cx) => {
        if (!win()?.visible || this.closed) return;
        this.checkConnectionHealth(cx);
      });
    }
  }

  myPaneId() {
    if (!this.id) return null;
    const mzPanes = panes().filter((p) => p.mod === "mayonaka-mizar");
    const liveSet = new Set(mzPanes.map((p) => p.pane));
    const rawIds = shared(IDS_KEY) ?? {};
    const ids = {};
    let stale = false;
    for (const [pane, mid] of Object.entries(rawIds)) {
      if (liveSet.has(pane)) ids[pane] = mid;
      else stale = true;
    }
    for (const [pane, mid] of Object.entries(ids)) {
      if (mid === this.id) {
        if (stale) setShared(IDS_KEY, ids);
        this.boundPane = pane;
        return pane;
      }
    }
    const unclaimed = mzPanes.filter((p) => !ids[p.pane]);
    if (unclaimed.length === 1) {
      const pane = unclaimed[0].pane;
      setShared(IDS_KEY, { ...ids, [pane]: this.id });
      this.boundPane = pane;
      return pane;
    }
    if (stale) setShared(IDS_KEY, ids);
    return this.boundPane;
  }

  publishStatus() {
    const pane = this.myPaneId();
    if (!pane) return;
    const s = this.sessionState;
    const entry = {
      id: this.id,
      pid: this.managedPid,
      sessionId: s.session?.id ?? null,
      title: s.session?.title ?? null,
      cwd: s.session?.cwd ?? this.cwd ?? null,
      state: this.client ? s.state : (this.launching ? "streaming" : "disconnected"),
      model: s.config?.model ?? null,
      pendingCount: s.pendingInteractions?.length ?? 0,
    };
    const all = { ...(shared(PANES_KEY) ?? {}) };
    const prev = all[pane];
    if (
      prev?.pid !== entry.pid ||
      prev?.sessionId !== entry.sessionId ||
      prev?.title !== entry.title ||
      prev?.cwd !== entry.cwd ||
      prev?.state !== entry.state ||
      prev?.pendingCount !== entry.pendingCount
    ) {
      all[pane] = entry;
      setShared(PANES_KEY, all);
    }
  }

  clearPaneRegistration() {
    if (!this.boundPane) return;
    const allPanes = { ...(shared(PANES_KEY) ?? {}) };
    if (allPanes[this.boundPane]) {
      delete allPanes[this.boundPane];
      setShared(PANES_KEY, allPanes);
    }
    const ids = { ...(shared(IDS_KEY) ?? {}) };
    if (ids[this.boundPane] === this.id) {
      delete ids[this.boundPane];
      setShared(IDS_KEY, ids);
    }
  }

  saveInstanceState() {
    try {
      const sid = this.sessionState.session?.id;
      localStorage.setItem(storageKeyForInstance(this.id), JSON.stringify({
        pid: this.managedPid,
        sessionId: sid ?? null,
        cwd: this.cwd,
        owned: Boolean(this.ownedPid && this.ownedPid === this.managedPid),
      }));
    } catch {}
  }

  loadInstanceState() {
    try {
      const raw = localStorage.getItem(storageKeyForInstance(this.id));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  async close() {
    this.closed = true;
    try { this.healthTimer?.cancel?.(); } catch {}
    try { this.client?.close(); } catch {}
    this.client = null;
    this.clearPaneRegistration();
    // Only kill owned headless host if the pane itself was closed (not kept across mod reload).
    const paneStillExists = Boolean(this.boundPane && panes().some((p) => p.pane === this.boundPane));
    if (this.ownedPid && !paneStillExists && !checking()) {
      try {
        await exec("kill", ["-TERM", String(this.ownedPid)]);
      } catch {}
      try { localStorage.removeItem(storageKeyForInstance(this.id)); } catch {}
    }
    try { this.composer?.release(); } catch {}
    try { this.scroll?.release(); } catch {}
  }

  startCommandLoop(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (this.closed) return;
        const pane = this.myPaneId();
        const f = focused();
        const isTarget = !pane || !f?.pane || f.pane === pane;
        if (!isTarget) continue;
        if (cmd === "focus") {
          this.composer.focus();
        } else if (cmd === "cancel") {
          await this.cancelTurn(cx);
        }
        cx.notify();
      }
    });
  }

  async resolveMizarBin() {
    const localBin = `${home()}/.local/bin/mizar`;
    try {
      if (await fs.exists(localBin)) return localBin;
    } catch {}
    const cargoBin = `${home()}/.cargo/bin/mizar`;
    try {
      if (await fs.exists(cargoBin)) return cargoBin;
    } catch {}
    return "mizar";
  }

  async launchOrAttach(cx) {
    if (this.launching || this.closed) return;
    this.launching = true;
    this.error = null;
    this.publishStatus();
    cx.notify();

    try {
      const saved = this.loadInstanceState();
      if (saved?.cwd && !props()?.cwd) this.cwd = saved.cwd;

      const liveProcs = await scanRunDir(runDirPath(), {
        readdir: fs.readdir,
        readFile: fs.readFile,
      });

      let targetMeta = null;
      if (this.attachOnlyPid) {
        targetMeta = liveProcs.find((p) => p.pid === this.attachOnlyPid) ?? null;
      } else if (saved?.pid) {
        targetMeta = liveProcs.find((p) => p.pid === saved.pid) ?? null;
        if (targetMeta && saved.owned) this.ownedPid = targetMeta.pid;
      }

      if (!targetMeta) {
        const bin = await this.resolveMizarBin();
        const cacheDir = cacheDirPath();
        try { await fs.mkdir(cacheDir, { recursive: true }); } catch {}
        const readyFile = `${cacheDir}/ready-${this.id}-${Date.now()}.json`;
        const launchCmd = buildLaunchCommand({
          bin,
          workspace: this.cwd,
          readyFile,
          resumeSessionId: saved?.sessionId ?? null,
          idleExitSecs: 45,
        });
        const spawnRes = await exec("sh", ["-c", launchCmd], { cwd: this.cwd, timeout: 10000 });
        if (this.closed) return;
        if (spawnRes.code !== 0) {
          throw new Error(spawnRes.stderr?.trim() || `Failed to launch mizar rpc (exit ${spawnRes.code})`);
        }
        targetMeta = await waitForReadyFile(readyFile, {
          readFile: fs.readFile,
          unlink: fs.unlink,
          sleep: (ms) => cx.sleep(ms),
          timeoutMs: 12000,
        });
        this.ownedPid = targetMeta.pid;
      }

      if (this.closed) return;
      await this.connectToMeta(targetMeta, cx);
      this.indexWorkspaceFiles(cx);
    } catch (err) {
      if (!this.closed) {
        this.error = err?.message ?? String(err);
      }
    } finally {
      this.launching = false;
      if (!this.closed) {
        this.publishStatus();
        cx.notify();
      }
    }
  }

  async connectToMeta(meta, cx) {
    if (this.client) {
      this.client.close();
      this.client = null;
    }

    const client = new MizarRpcClient({
      connectTcp: (host, port) => net.connect(host, port),
      setTimer: (ms, fn) => cx.timer.after(ms, () => fn()),
      clearTimer: (h) => h?.cancel?.(),
    });

    client.onNotification((method, params) => {
      if (this.closed || this.client !== client) return;
      const next = applyNotification(this.sessionState, method, params);
      const switched = next.switchedTo;
      this.sessionState = next;
      if (switched) {
        this.subscribeTo(switched, null, cx);
      } else {
        if (method === "event.committed") {
          this.scrollToBottom();
        }
        this.publishStatus();
        cx.notify();
      }
    });

    client.onClose((err) => {
      if (this.closed || this.client !== client) return;
      this.client = null;
      if (err && !this.error) this.error = err.message;
      this.publishStatus();
      cx.notify();
    });

    await client.connect(meta);
    if (this.closed) {
      client.close();
      return;
    }
    this.client = client;
    this.managedPid = meta.pid;

    const snap = await client.sessionSubscribe(meta.session_id, null, 80);
    this.sessionState = applySnapshot(createSessionState(), snap, { parentSessionId: null });
    this.saveInstanceState();
    this.scrollToBottom();

    try {
      this.capabilities = await client.capabilitiesList(meta.session_id);
    } catch {
      this.capabilities = null;
    }
    this.error = null;
    this.publishStatus();
  }

  async checkConnectionHealth(cx) {
    if (this.launching || this.closed) return;
    if (!this.client || this.client.closed) {
      await this.launchOrAttach(cx);
    }
  }

  indexWorkspaceFiles(cx) {
    const cwd = this.sessionState.session?.cwd ?? this.cwd;
    if (!cwd) return;
    cx.spawn(async (cx) => {
      const files = await resolveWorkspaceFiles(cwd, { exec });
      if (!this.closed) {
        this.workspaceFiles = files;
        cx.notify();
      }
    });
  }

  scrollToBottom() {
    try {
      this.scroll?.scroll_to_bottom?.();
    } catch {}
  }

  flashNotice(msg, cx) {
    this.flash = msg;
    cx?.notify?.();
    if (cx) {
      cx.timer.after(3200, (cx) => {
        if (this.flash === msg && !this.closed) {
          this.flash = null;
          cx.notify();
        }
      });
    }
  }

  async subscribeTo(sessionId, parentSessionId, cx) {
    if (!this.client || this.client.closed || !sessionId) return;
    try {
      const snap = await this.client.sessionSubscribe(sessionId, null, 80);
      this.sessionState = applySnapshot(createSessionState(), snap, { parentSessionId });
      if (!parentSessionId) this.saveInstanceState();
      this.scrollToBottom();
      this.publishStatus();
      cx.notify();
    } catch (err) {
      this.error = err?.message ?? String(err);
      cx.notify();
    }
  }

  getSlashItems() {
    const serverCmds = Array.isArray(this.capabilities?.commands) ? this.capabilities.commands : [];
    const merged = new Map();
    for (const c of BUILTIN_SLASH_META) merged.set(c.command, c);
    for (const c of serverCmds) {
      if (!merged.has(c.command)) merged.set(c.command, c);
    }
    for (const sk of this.capabilities?.skills ?? []) {
      const name = sk.name;
      if (name && !merged.has(name)) {
        merged.set(name, { command: name, description: sk.description || `skill (${sk.source})`, takes_arg: true });
      }
    }
    return [...merged.values()];
  }

  getCompletionState() {
    const comp = detectActiveCompletion(this.draft);
    if (!comp) return { comp: null, items: [] };
    if (comp.kind === "slash") {
      const q = comp.query;
      const items = this.getSlashItems()
        .filter((c) => !q || c.command.includes(q) || c.description.toLowerCase().includes(q))
        .slice(0, 8)
        .map((c) => ({ kind: "slash", key: c.command, title: `/${c.command}`, detail: c.description, takesArg: Boolean(c.takes_arg) }));
      return { comp, items };
    }
    if (comp.kind === "mention") {
      const matches = filterFileCandidates(this.workspaceFiles, comp.query, 8);
      return {
        comp,
        items: matches.map((file) => ({ kind: "mention", key: file, title: file, detail: "" })),
      };
    }
    return { comp: null, items: [] };
  }

  applyCompletion(item, comp, cx) {
    const cur = this.composer.value();
    const before = cur.slice(0, comp.replaceStart);
    const after = cur.slice(comp.replaceEnd);
    const inserted = item.kind === "slash"
      ? `/${item.key}${item.takesArg ? " " : ""}`
      : `@${item.key} `;
    const next = `${before}${inserted}${after}`;
    this.composer.set_value(next);
    this.draft = next;
    this.compIdx = 0;
    this.composer.focus();
    cx.notify();
  }

  clearComposer(cx) {
    this.composer.set_value("");
    this.draft = "";
    this.compIdx = 0;
    cx.notify();
  }

  async submitComposer(cx, { steer = false } = {}) {
    const rawText = this.composer.value();
    const completion = this.getCompletionState();
    const parsed = parseComposerCommand(rawText);
    if (parsed.kind === "empty") return;
    if (!this.client || this.client.closed || !this.sessionState.session?.id) {
      this.flashNotice("Still connecting to Mizar…", cx);
      return;
    }

    const sid = this.sessionState.session.id;

    if (parsed.kind === "slash") {
      const exactMatch = this.getSlashItems().some((c) => c.command === parsed.command);
      if (!exactMatch && completion.comp?.kind === "slash" && completion.items.length > 0) {
        const pick = completion.items[Math.min(this.compIdx, completion.items.length - 1)];
        if (pick) {
          this.applyCompletion(pick, completion.comp, cx);
          return;
        }
      }
      const handled = await this.handleSlashCommand(parsed.command, parsed.arg, sid, cx);
      if (handled) {
        this.clearComposer(cx);
        return;
      }
      // Forward unknown /commands (such as /skill-name) to AgentLoop.
    }

    if (parsed.kind === "bash") {
      if (!parsed.command) {
        this.flashNotice("Enter a shell command after ! or !!", cx);
        return;
      }
      this.clearComposer(cx);
      this.runningBash = true;
      cx.notify();
      try {
        const res = await this.client.bashRun(sid, parsed.command, parsed.excludeFromContext);
        if (res.cancelled) this.flashNotice(`Cancelled: ${res.command}`, cx);
      } catch (err) {
        this.flashNotice(err?.message ?? String(err), cx);
      } finally {
        this.runningBash = false;
        this.scrollToBottom();
        cx.notify();
      }
      return;
    }

    const mode = steer ? "steer" : (this.sessionState.state !== "idle" ? "queue" : "send");
    this.clearComposer(cx);
    try {
      await this.client.turnSubmit(sid, parsed.text ?? rawText, mode, []);
      this.scrollToBottom();
      cx.notify();
    } catch (err) {
      this.composer.set_value(rawText);
      this.draft = rawText;
      this.flashNotice(err?.message ?? String(err), cx);
    }
  }

  async handleSlashCommand(cmd, arg, sid, cx) {
    try {
      if (cmd === "new" || cmd === "clear") {
        const res = await this.client.sessionNew(arg || null);
        this.picker = null;
        if (res?.session?.id) await this.subscribeTo(res.session.id, null, cx);
        return true;
      }
      if (cmd === "resume") {
        if (arg) {
          const res = await this.client.sessionSwitch(arg);
          this.picker = null;
          if (res?.session?.id) await this.subscribeTo(res.session.id, null, cx);
          return true;
        }
        await this.openPicker("resume", cx);
        return true;
      }
      if (cmd === "model") {
        if (arg) {
          const slash = arg.indexOf("/");
          const patch = slash > 0
            ? { provider: arg.slice(0, slash), model: arg.slice(slash + 1) }
            : { model: arg };
          const res = await this.client.sessionConfig(sid, patch);
          if (res?.config) {
            this.sessionState = { ...this.sessionState, config: res.config, context: res.context ?? this.sessionState.context };
          }
          this.picker = null;
          this.publishStatus();
          return true;
        }
        await this.openPicker("models", cx);
        return true;
      }
      if (cmd === "effort") {
        if (arg && EFFORTS.includes(arg.toLowerCase())) {
          const res = await this.client.sessionConfig(sid, { reasoning_effort: arg.toLowerCase() });
          if (res?.config) this.sessionState = { ...this.sessionState, config: res.config };
          this.picker = null;
          return true;
        }
        await this.openPicker("effort", cx);
        return true;
      }
      if (cmd === "compact") {
        this.flashNotice("Compacting context…", cx);
        const res = await this.client.sessionCompact(sid, arg || null);
        this.flashNotice(res?.message || (res?.compacted ? "Compacted context" : "Compaction skipped"), cx);
        return true;
      }
      if (cmd === "tree") {
        await this.openPicker("tree", cx);
        return true;
      }
      if (cmd === "fork") {
        const seq = Number(arg);
        if (Number.isInteger(seq) && seq > 0) {
          await this.forkAt(seq, cx);
        } else {
          await this.openPicker("tree", cx);
        }
        return true;
      }
      if (cmd === "approve" || cmd === "approval") {
        const nextMode = arg && (arg.toLowerCase() === "ask" || arg.toLowerCase() === "auto")
          ? arg.toLowerCase()
          : (this.sessionState.config?.approval_mode === "ask" ? "auto" : "ask");
        const res = await this.client.sessionConfig(sid, { approval_mode: nextMode });
        if (res?.config) this.sessionState = { ...this.sessionState, config: res.config };
        this.flashNotice(`Approval mode: ${nextMode}`, cx);
        return true;
      }
      if (cmd === "help") {
        await this.openPicker("help", cx);
        return true;
      }
    } catch (err) {
      this.flashNotice(err?.message ?? String(err), cx);
      return true;
    }
    return false;
  }

  async openPicker(kind, cx) {
    if (this.picker === kind) {
      this.picker = null;
      cx.notify();
      return;
    }
    this.picker = kind;
    const sid = this.sessionState.session?.id;
    if (this.client) {
      try {
        if (kind === "resume") {
          const res = await this.client.sessionList({ cwd: this.cwd, limit: 25 });
          this.historyItems = res?.sessions ?? [];
        } else if (kind === "tree" && sid) {
          const res = await this.client.sessionTree(sid);
          this.treeEntries = res?.entries ?? [];
        } else if (kind === "models" && !this.capabilities) {
          this.capabilities = await this.client.capabilitiesList(sid);
        }
      } catch (err) {
        this.flashNotice(err?.message ?? String(err), cx);
      }
    }
    cx.notify();
  }

  async switchModel(provider, model, cx) {
    const sid = this.sessionState.session?.id;
    if (!this.client || !sid) return;
    try {
      const res = await this.client.sessionConfig(sid, { provider, model });
      if (res?.config) {
        this.sessionState = { ...this.sessionState, config: res.config, context: res.context ?? this.sessionState.context };
      }
      this.picker = null;
      this.publishStatus();
      cx.notify();
    } catch (err) {
      this.flashNotice(err?.message ?? String(err), cx);
    }
  }

  async switchEffort(effort, cx) {
    const sid = this.sessionState.session?.id;
    if (!this.client || !sid) return;
    try {
      const res = await this.client.sessionConfig(sid, { reasoning_effort: effort });
      if (res?.config) this.sessionState = { ...this.sessionState, config: res.config };
      this.picker = null;
      cx.notify();
    } catch (err) {
      this.flashNotice(err?.message ?? String(err), cx);
    }
  }

  async toggleApprovalMode(cx) {
    const sid = this.sessionState.session?.id;
    if (!this.client || !sid) return;
    const nextMode = this.sessionState.config?.approval_mode === "ask" ? "auto" : "ask";
    try {
      const res = await this.client.sessionConfig(sid, { approval_mode: nextMode });
      if (res?.config) this.sessionState = { ...this.sessionState, config: res.config };
      cx.notify();
    } catch (err) {
      this.flashNotice(err?.message ?? String(err), cx);
    }
  }

  async forkAt(seq, cx) {
    const sid = this.sessionState.session?.id;
    if (!this.client || !sid) return;
    try {
      const res = await this.client.sessionFork(sid, seq);
      if (res?.session?.id) {
        this.picker = null;
        await this.client.sessionSwitch(res.session.id);
        await this.subscribeTo(res.session.id, null, cx);
        notify({ title: "Mizar", body: `Forked branch @ #${seq}`, level: "success" });
      }
    } catch (err) {
      this.flashNotice(err?.message ?? String(err), cx);
    }
  }

  async loadEarlier(cx) {
    const sid = this.sessionState.session?.id;
    const firstSeq = this.sessionState.events?.[0]?.seq;
    if (!this.client || !sid || !firstSeq || this.loadingHistory) return;
    this.loadingHistory = true;
    cx.notify();
    try {
      const res = await this.client.sessionEvents(sid, { beforeSeq: firstSeq, limit: 40 });
      this.sessionState = prependPagedEvents(this.sessionState, res.events ?? [], res.has_more);
    } catch (err) {
      this.flashNotice(err?.message ?? String(err), cx);
    } finally {
      this.loadingHistory = false;
      if (!this.closed) cx.notify();
    }
  }

  async cancelTurn(cx) {
    const sid = this.sessionState.session?.id;
    if (!this.client || !sid) return;
    try {
      await this.client.turnCancel(sid);
    } catch (err) {
      this.flashNotice(err?.message ?? String(err), cx);
    }
  }

  async resolveInteraction(requestId, decision, cx) {
    if (!this.client) return;
    try {
      const res = await this.client.interactionResolve(requestId, decision);
      if (res?.ok === false && res?.reason) {
        this.flashNotice(`Approval ${res.reason}`, cx);
      }
    } catch (err) {
      this.flashNotice(err?.message ?? String(err), cx);
    }
  }

  async popAllQueue(cx) {
    const sid = this.sessionState.session?.id;
    if (!this.client || !sid) return;
    try {
      const res = await this.client.queuePopAll(sid);
      const popped = (res?.items ?? []).map((it) => it.text).filter(Boolean).join("\n");
      if (popped) {
        const existing = this.composer.value();
        const combined = existing ? `${existing}\n${popped}` : popped;
        this.composer.set_value(combined);
        this.draft = combined;
        this.composer.focus();
      }
      cx.notify();
    } catch (err) {
      this.flashNotice(err?.message ?? String(err), cx);
    }
  }

  pill(t, id, label, active, onClick) {
    return h_flex()
      .id(id)
      .h(21)
      .px(8)
      .items_center()
      .rounded(5)
      .cursor_pointer()
      .border_1()
      .border_color(active ? t.accent : t.border)
      .bg(active ? t.selected : t.surface)
      .text_color(active ? t.foreground : t.muted)
      .text_size(11)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click(onClick)
      .child(label);
  }

  renderMarkdownAndPills(t, keyPrefix, markdownText) {
    const blocks = splitMarkdownWithPills(markdownText);
    if (blocks.length === 0) return null;
    return v_flex()
      .gap(6)
      .children(blocks.map((blk, i) => {
        if (blk.type === "markdown") {
          return TextView.markdown(`${keyPrefix}-md-${i}`, blk.text).selectable(true).raw_html(false);
        }
        return h_flex()
          .flex_wrap()
          .gap(5)
          .items_center()
          .children(blk.segments.map((seg) => {
            if (seg.type === "text") {
              return div().text_size(13).text_color(t.foreground).child(seg.text);
            }
            const pal = pillPalette(t, seg.tone);
            return h_flex()
              .px(7)
              .py(1)
              .rounded_full()
              .border_1()
              .border_color(pal.bd)
              .bg(pal.bg)
              .text_size(11)
              .font_semibold()
              .text_color(pal.fg)
              .child(seg.word);
          }));
      }));
  }

  isToolExpanded(item, autoExpand) {
    if (this.toggledTools.has(item.seq)) return this.toggledTools.get(item.seq);
    return autoExpand;
  }

  renderDiffBody(t, diffText) {
    const { lines, truncated } = parseUnifiedDiff(diffText, 240);
    if (!lines.length) return null;
    return v_flex()
      .gap(1)
      .px(6)
      .py(5)
      .rounded(6)
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .children(lines.map((ln) => {
        let bg = null;
        let fg = t.muted;
        if (ln.kind === "add") {
          bg = withAlpha(t.done, "1c", t.surface);
          fg = t.done;
        } else if (ln.kind === "del") {
          bg = withAlpha(t.blocked, "1c", t.surface);
          fg = t.blocked;
        } else if (ln.kind === "hunk") {
          bg = withAlpha(t.accent, "16", t.chrome);
          fg = t.accent;
        } else if (ln.kind === "meta") {
          fg = t.dim;
        }
        const lnNum = ln.kind === "add"
          ? String(ln.newLine ?? "").padStart(4, " ")
          : ln.kind === "del"
            ? String(ln.oldLine ?? "").padStart(4, " ")
            : (ln.newLine ?? ln.oldLine ?? "") ? String(ln.newLine ?? ln.oldLine).padStart(4, " ") : "    ";
        return h_flex()
          .gap(8)
          .px(4)
          .rounded(3)
          .when(Boolean(bg), (el) => el.bg(bg))
          .text_size(11.5)
          .child(div().flex_none().text_color(t.dim).child(lnNum))
          .child(div().flex_1().min_w(0).text_color(fg).child(ln.text));
      }))
      .when(truncated > 0, (el) => el.child(div().pt(3).text_size(10.5).text_color(t.dim).child(`… ${truncated} more lines`)));
  }

  renderToolResult(t, item, cx) {
    const m = item.meta;
    const isDiff = m?.kind === "diff" && Boolean(m.diff);
    const diffLineCount = isDiff ? String(m.diff).split("\n").length : 0;
    const autoExpand = Boolean(item.isError || (isDiff && diffLineCount <= 28));
    const expanded = this.isToolExpanded(item, autoExpand);
    const toggle = () => {
      this.toggledTools.set(item.seq, !expanded);
      cx.notify();
    };

    let headline = item.name;
    let subtitle = "";
    if (m?.kind === "diff") {
      headline = `edit ${m.path ?? ""}`;
      subtitle = `+${m.added ?? 0} / -${m.removed ?? 0}`;
    } else if (m?.kind === "write") {
      headline = `write ${m.path ?? ""}`;
      subtitle = `${m.bytes ?? 0} B · ${m.lines ?? 0} lines`;
    } else if (m?.kind === "bash") {
      headline = `$ ${truncateText(m.command ?? "", 64)}`;
      subtitle = `exit ${m.exit_code ?? "?"}${m.duration_ms != null ? ` · ${m.duration_ms}ms` : ""}`;
    } else if (m?.kind === "read") {
      headline = `read ${m.path ?? ""}`;
      subtitle = m.start_line ? `L${m.start_line}-${m.end_line}` : "";
    } else if (m?.kind === "grep" || m?.kind === "find") {
      headline = `${m.kind}`;
      subtitle = `${m.matches ?? m.count ?? 0} hits`;
    }

    return v_flex()
      .id(`mz-tr-${item.seq}`)
      .px(10)
      .py(6)
      .gap(6)
      .rounded(7)
      .border_1()
      .border_color(item.isError ? t.blocked : t.border)
      .bg(t.surface)
      .child(
        h_flex().gap(8).items_center().cursor_pointer().on_click(toggle)
          .child(div().text_size(11.5).font_medium().text_color(item.isError ? t.blocked : t.foreground).child(headline))
          .when(Boolean(subtitle), (el) => el.child(div().flex_1().truncate().text_size(11).text_color(m?.kind === "diff" ? t.accent : t.dim).child(subtitle)))
          .when(!subtitle, (el) => el.child(div().flex_1()))
          .child(div().text_size(10.5).text_color(t.muted).child(expanded ? "▾" : "▸")),
      )
      .when(expanded && isDiff, (el) => el.child(this.renderDiffBody(t, m.diff)))
      .when(expanded && !isDiff && Boolean(item.content), (el) => el.child(
        div().p(7).rounded(5).bg(t.background).text_size(11.5).text_color(item.isError ? t.blocked : t.muted).child(truncateText(item.content, 2400)),
      ));
  }

  renderEventRow(t, ev, cx) {
    const item = summarizeCommittedEvent(ev);

    if (item.kind === "user") {
      return v_flex()
        .pl(12)
        .pr(10)
        .py(8)
        .gap(4)
        .rounded(6)
        .border_l_2()
        .border_color(t.accent)
        .bg(t.chrome)
        .child(h_flex().items_center().gap(6)
          .child(div().flex_1().text_size(11).font_semibold().text_color(t.accent).child("You"))
          .when(Boolean(this.client && item.seq), (el) => el.child(
            div().id(`mz-fk-${item.seq}`).px(5).py(1).rounded(4).cursor_pointer().text_size(10).text_color(t.dim)
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click(() => this.forkAt(item.seq, cx))
              .child("Fork"),
          )))
        .child(div().text_size(13).text_color(t.foreground).child(item.text));
    }

    if (item.kind === "assistant") {
      const { reasoning, text, toolCalls } = flattenAssistantBlocks(item.blocks);
      const showReason = this.expandedReasoning.has(item.seq);
      return v_flex()
        .py(4)
        .gap(6)
        .when(Boolean(reasoning), (el) => el.child(
          h_flex().gap(8).items_center()
            .child(this.pill(t, `mz-rsn-${item.seq}`, showReason ? "▾ Thinking" : "▸ Thinking", showReason, () => {
              if (showReason) this.expandedReasoning.delete(item.seq);
              else this.expandedReasoning.add(item.seq);
              cx.notify();
            })),
        ))
        .when(showReason && Boolean(reasoning), (el) => el.child(
          div().pl(10).border_l_2().border_color(t.border).text_size(11.5).text_color(t.dim).child(truncateText(reasoning, 2000)),
        ))
        .when(Boolean(text), (el) => el.child(this.renderMarkdownAndPills(t, `mz-a-${item.seq}`, text)))
        .when(toolCalls.length > 0, (el) => el.child(
          h_flex().flex_wrap().gap(5).children(toolCalls.map((tc, i) =>
            div().px(7).py(2).rounded(5).bg(t.surface).border_1().border_color(t.border).text_size(11).text_color(t.muted).child(`⚙ ${tc.name ?? `call-${i + 1}`}`))),
        ));
    }

    if (item.kind === "tool-result") {
      return this.renderToolResult(t, item, cx);
    }

    if (item.kind === "bash-execution") {
      const exitOk = item.exitCode === 0;
      return v_flex()
        .px(10)
        .py(7)
        .gap(4)
        .rounded(7)
        .bg(t.surface)
        .border_1()
        .border_color(exitOk ? t.border : t.blocked)
        .child(h_flex().gap(8).items_center()
          .child(div().flex_1().truncate().text_size(11.5).font_medium().text_color(t.foreground).child(`! ${item.command}`))
          .child(div().text_size(10.5).text_color(item.excludeFromContext ? t.dim : t.accent).child(item.excludeFromContext ? "local" : "in context"))
          .child(div().text_size(10.5).text_color(exitOk ? t.done : t.blocked).child(`exit ${item.exitCode ?? "?"}`)))
        .when(Boolean(item.output), (el) => el.child(
          div().p(7).rounded(5).bg(t.background).text_size(11.5).text_color(t.muted).child(truncateText(item.output, 1600)),
        ));
    }

    if (item.kind === "approval") {
      return div().px(8).py(3).text_size(11).text_color(t.dim)
        .child(`Approval · ${item.tool} → ${item.decision} (${item.resolvedBy})`);
    }

    if (item.kind === "turn-end") {
      const sum = item.summary;
      const parts = [`Turn ${item.turn} · ${item.reason}`];
      if (sum) {
        parts.push(`${sum.durationMs ?? 0}ms`);
        if (sum.filesChanged?.length) parts.push(`${sum.filesChanged.length} file(s)`);
        if (sum.commandsRun) parts.push(`${sum.commandsRun} cmd(s)`);
        if (sum.toolErrors) parts.push(`${sum.toolErrors} err(s)`);
      }
      if (item.error) parts.push(`Error: ${truncateText(item.error, 180)}`);
      return div().pt(2).pb(4).border_b(1).border_color(t.border).text_size(10.5).text_color(item.error ? t.blocked : t.dim).child(parts.join(" · "));
    }

    if (item.kind === "compaction") {
      return div().px(10).py(5).rounded(6).bg(t.chrome).text_size(11).text_color(t.dim)
        .child(`Compacted history through seq ${item.firstKeptSeq}${item.tokensBefore && item.tokensAfter ? ` (${fmtTokens(item.tokensBefore)} → ${fmtTokens(item.tokensAfter)})` : ""}`);
    }

    if (item.kind === "context-notice" || item.kind === "turn-notice" || item.kind === "tool-result-prune") {
      return div().px(6).py(2).text_size(10.5).text_color(t.dim).child(item.text || item.notice || item.kind);
    }

    return null;
  }

  renderActiveTurn(t) {
    const at = this.sessionState.activeTurn;
    if (!at) return null;
    const hasBody = Boolean(at.reasoning || at.text || at.running_tools?.length);
    if (!hasBody) {
      return h_flex().py(4).gap(8).items_center()
        .child(svg(SPINNER_ICON).size(12).text_color(t.working).spin(900))
        .child(div().text_size(12).text_color(t.muted).child(`Thinking · Step ${at.step}…`));
    }
    return v_flex().py(4).gap(8)
      .when(Boolean(at.reasoning), (el) => el.child(
        div().pl(10).border_l_2().border_color(t.border).text_size(11.5).text_color(t.dim).child(truncateText(at.reasoning, 1400)),
      ))
      .when(Boolean(at.text), (el) => el.child(this.renderMarkdownAndPills(t, "mz-live", at.text)))
      .children((at.running_tools ?? []).map((rt) => v_flex().px(10).py(6).gap(4).rounded(7).bg(t.surface).border_1().border_color(t.border)
        .child(h_flex().gap(6).items_center()
          .child(svg(SPINNER_ICON).size(11).text_color(t.working).spin(900))
          .child(div().text_size(11.5).font_medium().text_color(t.foreground).child(rt.name)))
        .when(Boolean(rt.output_tail), (el) => el.child(div().text_size(11).text_color(t.muted).child(truncateText(rt.output_tail, 800))))));
  }

  renderLaunchpad(t) {
    const model = this.sessionState.config?.model
      ? `${this.sessionState.config.provider ?? ""}${this.sessionState.config.provider ? "/" : ""}${this.sessionState.config.model}`
      : "connecting…";
    const rowHint = (key, desc) => h_flex().gap(10).items_center()
      .child(div().px(6).py(2).rounded(5).bg(t.chrome).border_1().border_color(t.border).text_size(11).font_medium().text_color(t.accent).child(key))
      .child(div().text_size(11.5).text_color(t.muted).child(desc));

    return v_flex()
      .w_full()
      .py(36)
      .items_center()
      .gap(14)
      .child(svg(MOD_ICON).size(28).text_color(t.accent))
      .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Mizar"))
      .child(div().text_size(11.5).text_color(t.dim).child(`${shortHome(this.sessionState.session?.cwd ?? this.cwd)} · ${model}`))
      .child(
        v_flex().pt(8).gap(6)
          .child(rowHint("/model · /resume · /compact · /new · /tree", "Slash commands & session lineage"))
          .child(rowHint("@file", "Reference files & directories into context"))
          .child(rowHint("!cmd  ·  !!cmd", "Run local shell (!! skips context)")),
      );
  }

  renderSubagentBar(t, cx) {
    const { subagents, parentSessionId, session } = this.sessionState;
    if (!parentSessionId && !subagents.length) return null;
    return h_flex()
      .flex_none()
      .px(12)
      .py(5)
      .gap(6)
      .items_center()
      .overflow_x_scrollbar()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .when(Boolean(parentSessionId), (el) => el.child(this.pill(t, "mz-back-parent", "← Parent", true, () => {
        this.subscribeTo(parentSessionId, null, cx);
      })))
      .children(subagents.map((sub) => this.pill(
        t,
        `mz-sub-${sub.child_session_id}`,
        `${sub.name} · ${sub.status}${sub.current_step ? ` (${sub.current_step})` : ""}`,
        session?.id === sub.child_session_id,
        () => this.subscribeTo(sub.child_session_id, session?.id ?? parentSessionId, cx),
      )));
  }

  renderApprovals(t, cx) {
    const items = this.sessionState.pendingInteractions;
    if (!items.length) return null;
    return v_flex()
      .flex_none()
      .px(12)
      .py(8)
      .gap(6)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.blocked)
      .children(items.map((req) => v_flex()
        .id(`mz-app-${req.request_id}`)
        .p(9)
        .gap(6)
        .rounded(7)
        .border_1()
        .border_color(t.blocked)
        .bg(t.background)
        .child(h_flex().gap(7).items_center()
          .child(div().size(7).rounded_full().bg(t.blocked))
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child(`Approval · ${req.tool}`))
          .child(div().flex_1().truncate().text_size(11).text_color(t.muted).child(req.summary ?? "")))
        .child(div().text_size(11).text_color(t.dim).child(truncateText(JSON.stringify(req.args ?? {}), 280)))
        .child(h_flex().gap(6)
          .child(this.pill(t, `mz-ok1-${req.request_id}`, "Allow once", true, () => this.resolveInteraction(req.request_id, "allow_once", cx)))
          .child(this.pill(t, `mz-oks-${req.request_id}`, "Allow session", false, () => this.resolveInteraction(req.request_id, "allow_session", cx)))
          .child(this.pill(t, `mz-deny-${req.request_id}`, "Deny", false, () => this.resolveInteraction(req.request_id, "deny", cx))))));
  }

  renderPicker(t, cx) {
    if (!this.picker) return null;
    const headerRow = (title) => h_flex().items_center().pb(4)
      .child(div().flex_1().text_size(11.5).font_semibold().text_color(t.muted).child(title))
      .child(div().id("mz-pk-close").px(5).cursor_pointer().text_size(11).text_color(t.dim).on_click(() => { this.picker = null; cx.notify(); }).child("Esc"));

    let body = null;
    if (this.picker === "models") {
      const providers = this.capabilities?.providers ?? [];
      body = v_flex().gap(4).child(headerRow("Switch model"))
        .children(providers.flatMap((prov) => (prov.models ?? []).map((m) => h_flex()
          .id(`mz-pm-${prov.id}-${m.id}`)
          .px(8).py(5).gap(8).rounded(6).cursor_pointer()
          .bg(this.sessionState.config?.model === m.id ? t.selected : t.surface)
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.switchModel(prov.id, m.id, cx))
          .child(div().flex_1().truncate().text_size(11.5).text_color(t.foreground).child(`${prov.id}/${m.id}`))
          .when(Boolean(m.context_window), (el) => el.child(div().text_size(10.5).text_color(t.dim).child(fmtTokens(m.context_window)))))));
    } else if (this.picker === "effort") {
      const cur = this.sessionState.config?.reasoning_effort ?? "default";
      body = v_flex().gap(4).child(headerRow("Reasoning effort"))
        .child(h_flex().flex_wrap().gap(6).children(EFFORTS.map((eff) =>
          this.pill(t, `mz-eff-${eff}`, eff, cur === eff, () => this.switchEffort(eff, cx)))));
    } else if (this.picker === "resume") {
      const curSid = this.sessionState.session?.id;
      body = v_flex().gap(4).child(headerRow("Resume workspace session"))
        .when(this.historyItems.length === 0, (el) => el.child(div().text_size(11.5).text_color(t.dim).child("No saved sessions in this workspace yet.")))
        .children(this.historyItems.map((h) => h_flex()
          .id(`mz-ph-${h.id}`)
          .px(8).py(5).gap(8).rounded(6).cursor_pointer()
          .bg(h.id === curSid ? t.selected : t.surface)
          .hover((s) => s.bg(t.hover))
          .on_click(async () => {
            try {
              const res = await this.client?.sessionSwitch(h.id);
              this.picker = null;
              if (res?.session?.id) await this.subscribeTo(res.session.id, null, cx);
            } catch (err) {
              this.flashNotice(err?.message ?? String(err), cx);
            }
          })
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(h.title || h.id.slice(0, 12)))
          .child(div().text_size(10.5).text_color(t.dim).child(`${h.event_count} ev`))));
    } else if (this.picker === "tree") {
      body = v_flex().gap(4).child(headerRow("Session tree"))
        .children(this.treeEntries.map((ent, idx) => h_flex()
          .id(`mz-ptr-${idx}`)
          .pl(8 + (ent.depth ?? 0) * 14).pr(8).py(4).gap(6).items_center().rounded(6).bg(t.surface)
          .hover((s) => s.bg(t.hover))
          .child(div().px(5).py(1).rounded(4).bg(t.chrome).text_size(10).text_color(t.accent).child(ent.kind_tag || "event"))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(ent.summary || `#${ent.seq}`))
          .child(div().text_size(10.5).text_color(t.dim).child(`#${ent.seq}`))
          .when(Boolean(this.client && ent.can_fork), (el) => el.child(
            this.pill(t, `mz-ptf-${ent.seq}-${idx}`, "Fork", false, () => this.forkAt(ent.seq, cx)),
          ))));
    } else if (this.picker === "help") {
      body = v_flex().gap(4).child(headerRow("Mizar commands & keys"))
        .children(BUILTIN_SLASH_META.map((c) => h_flex().gap(10).px(4).py(2)
          .child(div().w(84).text_size(11.5).font_medium().text_color(t.accent).child(`/${c.command}`))
          .child(div().flex_1().text_size(11.5).text_color(t.muted).child(c.description))))
        .child(div().pt(4).text_size(11).text_color(t.dim).child("@path injects file context · !cmd / !!cmd runs shell · Enter queues when busy · ⌥Enter steers · Esc stops"));
    }

    return v_flex()
      .flex_none()
      .max_h(220)
      .overflow_y_scroll()
      .px(12)
      .py(8)
      .bg(t.popover)
      .border_t(1)
      .border_color(t.border)
      .child(body ?? div());
  }

  renderCompletionPopup(t, completion, cx) {
    if (!completion.comp || completion.items.length === 0 || this.picker) return null;
    const sel = Math.min(this.compIdx, completion.items.length - 1);
    return v_flex()
      .flex_none()
      .max_h(190)
      .overflow_y_scroll()
      .px(12)
      .py(6)
      .gap(2)
      .bg(t.popover)
      .border_t(1)
      .border_color(t.border)
      .children(completion.items.map((item, idx) => h_flex()
        .id(`mz-cmp-${idx}`)
        .px(8)
        .py(4)
        .gap(10)
        .rounded(5)
        .cursor_pointer()
        .bg(idx === sel ? t.selected : t.popover)
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.applyCompletion(item, completion.comp, cx))
        .child(div().text_size(11.5).font_medium().text_color(idx === sel ? t.foreground : t.accent).child(item.title))
        .when(Boolean(item.detail), (el) => el.child(div().flex_1().truncate().text_size(11).text_color(t.muted).child(item.detail)))));
  }

  renderQueueStrip(t, cx) {
    const q = this.sessionState.queuedInputs;
    if (!q.length) return null;
    const sid = this.sessionState.session?.id;
    return v_flex().flex_none().px(12).py(5).gap(4).bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().items_center().child(div().flex_1().text_size(10.5).font_semibold().text_color(t.muted).child(`Queued (${q.length})`))
        .child(this.pill(t, "mz-q-pop", "Pop all", false, () => this.popAllQueue(cx))))
      .children(q.map((item) => h_flex().gap(6).items_center()
        .child(div().flex_1().truncate().text_size(11).text_color(t.foreground).child(item.text))
        .child(this.pill(t, `mz-q-rm-${item.id}`, "×", false, () => this.client?.queueRemove(sid, item.id)))));
  }

  renderComposerAndStatus(t, cx) {
    const s = this.sessionState;
    const busy = s.state !== "idle" || this.runningBash;
    const trimmed = this.draft.trimStart();
    const shellHint = trimmed.startsWith("!!")
      ? "!! local shell"
      : trimmed.startsWith("!")
        ? "! context shell"
        : null;

    const modelText = s.config?.model
      ? `${s.config.provider ?? ""}${s.config.provider ? "/" : ""}${s.config.model}`
      : (this.launching ? "starting mizar…" : "default model");
    const effortText = s.config?.reasoning_effort ?? "default";
    const approvalText = s.config?.approval_mode === "ask" ? "ask" : "auto";
    const ctxText = s.context?.max_tokens
      ? `${fmtTokens(s.context.used_tokens)} / ${fmtTokens(s.context.max_tokens)}`
      : `${fmtTokens(s.context?.used_tokens)} tok`;

    return v_flex()
      .flex_none()
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .child(
        v_flex().px(12).pt(8).pb(6).gap(6)
          .child(
            Textarea.new(this.composer)
              .w_full()
              .p(8)
              .rounded(7)
              .border_1()
              .border_color(this.composerFocused ? (shellHint ? t.working : t.accent) : t.input)
              .bg(t.background)
              .text_size(12.5)
              .text_color(t.foreground),
          )
          .when(Boolean(shellHint || busy || this.draft.length > 0), (el) => el.child(
            h_flex().gap(6).items_center()
              .when(Boolean(shellHint), (x) => x.child(div().px(6).py(1).rounded(4).bg(withAlpha(t.working, "22", t.surface)).text_size(10.5).font_semibold().text_color(t.working).child(shellHint)))
              .child(div().flex_1())
              .when(busy, (x) => x.child(this.pill(t, "mz-stop", "Stop (Esc)", true, () => this.cancelTurn(cx))))
              .when(busy && Boolean(this.draft.trim()), (x) => x.child(this.pill(t, "mz-steer", "Steer (⌥Enter)", false, () => this.submitComposer(cx, { steer: true })))),
          )),
      )
      .child(
        h_flex()
          .h(26)
          .px(12)
          .gap(10)
          .items_center()
          .border_t(1)
          .border_color(t.border)
          .text_size(11)
          .child(div().id("mz-st-model").cursor_pointer().text_color(t.muted).hover((x) => x.text_color(t.foreground))
            .on_click(() => this.openPicker("models", cx)).child(truncateText(modelText, 36)))
          .child(div().text_color(t.dim).child("·"))
          .child(div().id("mz-st-eff").cursor_pointer().text_color(t.muted).hover((x) => x.text_color(t.foreground))
            .on_click(() => this.openPicker("effort", cx)).child(effortText))
          .child(div().text_color(t.dim).child("·"))
          .child(div().id("mz-st-app").cursor_pointer().text_color(approvalText === "ask" ? t.blocked : t.muted).hover((x) => x.text_color(t.foreground))
            .on_click(() => this.toggleApprovalMode(cx)).child(approvalText))
          .when(busy, (el) => el.child(h_flex().gap(5).items_center()
            .child(svg(SPINNER_ICON).size(11).text_color(t.working).spin(900))
            .child(div().text_color(t.working).child(this.runningBash ? "shell" : "streaming"))))
          .child(div().flex_1())
          .child(div().id("mz-st-tree").cursor_pointer().text_color(t.dim).hover((x) => x.text_color(t.foreground))
            .on_click(() => this.openPicker("tree", cx)).child("tree"))
          .child(div().id("mz-st-ctx").cursor_pointer().text_color(t.dim).hover((x) => x.text_color(t.foreground))
            .on_click(() => this.handleSlashCommand("compact", "", s.session?.id, cx)).child(ctxText)),
      );
  }

  render(cx) {
    const t = theme();
    const s = this.sessionState;
    const visibleEvents = (s.events ?? []).filter(
      (e) => e.visibility !== "log-only" || e.kind === "approval" || e.kind === "turn-end" || e.kind === "turn-notice",
    );
    const activeTurnEl = this.renderActiveTurn(t);
    const completion = this.getCompletionState();

    return v_flex()
      .id(`mayonaka-mizar-${this.id}`)
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .bg(t.background)
      .overflow_hidden()
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.picker) {
            this.picker = null;
            cx.stop_propagation();
            cx.notify();
          } else if (s.state !== "idle") {
            this.cancelTurn(cx);
            cx.stop_propagation();
          }
          return;
        }
        if (completion.items.length > 0 && !this.picker) {
          if (e.key === "down") {
            this.compIdx = Math.min(this.compIdx + 1, completion.items.length - 1);
            cx.stop_propagation();
            cx.notify();
          } else if (e.key === "up") {
            this.compIdx = Math.max(this.compIdx - 1, 0);
            cx.stop_propagation();
            cx.notify();
          } else if (e.key === "tab") {
            const pick = completion.items[Math.min(this.compIdx, completion.items.length - 1)];
            if (pick) this.applyCompletion(pick, completion.comp, cx);
            cx.stop_propagation();
          }
        }
      })
      .child(this.renderSubagentBar(t, cx) ?? div())
      .when(Boolean(this.error), (el) => el.child(
        h_flex().px(12).py(6).bg(t.chrome).border_b(1).border_color(t.blocked).gap(8).items_center()
          .child(div().flex_1().text_size(11.5).text_color(t.blocked).child(this.error))
          .child(this.pill(t, "mz-retry", "Retry", false, () => this.launchOrAttach(cx))),
      ))
      .when(Boolean(this.flash), (el) => el.child(
        div().px(12).py(4).bg(t.chrome).border_b(1).border_color(t.border).text_size(11).text_color(t.accent).child(this.flash),
      ))
      .child(
        v_flex()
          .id("mizar-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scroll()
          .track_scroll(this.scroll)
          .px(16)
          .py(14)
          .items_center()
          .child(
            v_flex()
              .w_full()
              .max_w(860)
              .gap(10)
              .when(s.hasMoreHistory, (el) => el.child(
                h_flex().justify_center().child(
                  this.pill(t, "mz-load-more", this.loadingHistory ? "Loading…" : "Load earlier events", false, () => this.loadEarlier(cx)),
                ),
              ))
              .when(visibleEvents.length === 0 && !activeTurnEl, (el) => el.child(this.renderLaunchpad(t)))
              .children(visibleEvents.map((ev) => this.renderEventRow(t, ev, cx)).filter(Boolean))
              .when(Boolean(activeTurnEl), (el) => el.child(activeTurnEl)),
          ),
      )
      .child(this.renderApprovals(t, cx) ?? div())
      .child(this.renderQueueStrip(t, cx) ?? div())
      .child(this.renderPicker(t, cx) ?? div())
      .child(this.renderCompletionPopup(t, completion, cx) ?? div())
      .child(this.renderComposerAndStatus(t, cx));
  }
}
