// Native GPUI panel & card client for live Mizar sessions in Mayonaka.
// Connects directly to local Mizar instances via ~/.mizar/run/p-*.json (127.0.0.1 TCP + 0600 rpc_token).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, Textarea, TextareaState, ScrollHandle } from "gpui-base";
import {
  home, watchFolder, checking, spaces, panes, focused, props, run, theme,
  shared, setShared, window as win, notify, nextCommand,
} from "herdr";
import * as fs from "fs/promises";
import net from "net";
import {
  scanRunDir, pickTargetProcess, MizarRpcClient, createSessionState,
  applySnapshot, applyNotification, prependPagedEvents, summarizeCommittedEvent,
} from "./rpc.js";

const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const PANEL_STATE_KEY = "mayonaka-mizar.status";
const MOD_ICON = "mods/mayonaka-mizar/mizar.svg";
const SPINNER_ICON = "mods/workspace-chrome/spinner.svg";

function runDirPath() {
  return `${home()}/.mizar/run`;
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

function flattenTextBlocks(blocks) {
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

export default class MizarView extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.composer = TextareaState.new({
      placeholder: "Message Mizar… (Enter sends · Shift+Enter newline)",
      value: "",
      rows: 2,
    });
    this.composer.set_auto_grow(2, 6);
    this.composer.set_soft_wrap(true);

    this.closed = false;
    this.draft = "";
    this.submitMode = "send";
    this.processes = [];
    this.manualPid = props()?.pid ?? null;
    this.connectedPid = null;
    this.client = null;
    this.sessionState = createSessionState();
    this.capabilities = null;
    this.connecting = false;
    this.error = null;
    this.flash = null;
    this.drawer = null; // null | "processes" | "models" | "history" | "tree"
    this.historyItems = [];
    this.treeEntries = [];
    this.expandedReasoning = new Set();
    this.expandedTools = new Set();
    this.loadingHistory = false;
    this.composerFocused = false;
    this.watchHandle = null;
    this.pollTimer = null;

    this.composer.on("change", (_e, cx) => {
      this.draft = this.composer.value();
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
      this.submitComposer(cx);
    });

    if (!checking()) {
      this.refreshAndFollow(cx);
      this.pollTimer = cx.timer.every(2000, (cx) => {
        if (!win()?.visible || this.closed) return;
        this.refreshProcesses(cx);
      });
      this.startRunDirWatch(cx);
      this.startCommandLoop(cx);
    }
  }

  async close() {
    this.closed = true;
    try { this.watchHandle?.cancel?.(); } catch {}
    try { this.pollTimer?.cancel?.(); } catch {}
    try { this.client?.close(); } catch {}
    this.client = null;
    try { this.composer?.release(); } catch {}
    try { this.scroll?.release(); } catch {}
  }

  startCommandLoop(cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const cmd = await nextCommand();
        if (this.closed) return;
        if (cmd === "focus") {
          this.composer.focus();
        } else if (cmd === "send") {
          await this.submitComposer(cx);
        } else if (cmd === "cancel") {
          await this.cancelTurn(cx);
        }
        cx.notify();
      }
    });
  }

  startRunDirWatch(cx) {
    cx.spawn(async (cx) => {
      const dir = runDirPath();
      while (!this.closed) {
        try {
          if (await fs.exists(dir)) {
            this.watchHandle = watchFolder(dir);
            await this.watchHandle;
            if (this.closed) return;
            await this.refreshAndFollow(cx);
          } else {
            await cx.sleep(2500);
          }
        } catch {
          await cx.sleep(2500);
        }
      }
    });
  }

  publishStatus() {
    const s = this.sessionState;
    const payload = {
      pid: this.connectedPid,
      sessionId: s.session?.id ?? null,
      title: s.session?.title ?? null,
      cwd: s.session?.cwd ?? null,
      state: this.client ? s.state : "disconnected",
      model: s.config?.model ?? null,
      pendingCount: s.pendingInteractions?.length ?? 0,
    };
    const prev = shared(PANEL_STATE_KEY);
    if (
      prev?.pid !== payload.pid ||
      prev?.sessionId !== payload.sessionId ||
      prev?.title !== payload.title ||
      prev?.state !== payload.state ||
      prev?.pendingCount !== payload.pendingCount
    ) {
      setShared(PANEL_STATE_KEY, payload);
    }
  }

  matchContext() {
    const f = focused();
    const allPanes = panes();
    const activeSpace = spaces().find((s) => s.active);
    const activeTabId = f?.tab ?? activeSpace?.tabs?.find((t) => t.active)?.id;
    const focusedPane = f?.pane ? allPanes.find((p) => p.pane === f.pane) : null;
    const tabMizar = allPanes.find((p) => p.tab === activeTabId && !p.mod && p.app === "mizar");
    return {
      preferPid: this.manualPid,
      focusedPaneId: f?.pane ?? null,
      focusedCwd: focusedPane?.cwd ?? f?.cwd ?? null,
      activeTabCwd: tabMizar?.cwd ?? null,
      activeSpaceFolder: activeSpace?.folder ?? null,
    };
  }

  async refreshProcesses(cx) {
    const found = await scanRunDir(runDirPath(), { readdir: fs.readdir, readFile: fs.readFile });
    if (this.closed) return;
    const changed = JSON.stringify(found.map((p) => [p.pid, p.session_id, p.tcp_addr]))
      !== JSON.stringify(this.processes.map((p) => [p.pid, p.session_id, p.tcp_addr]));
    this.processes = found;
    if (!this.client || (this.connectedPid && !found.some((p) => p.pid === this.connectedPid))) {
      await this.ensureConnected(cx);
    } else if (changed) {
      cx.notify();
    }
  }

  async refreshAndFollow(cx) {
    await this.refreshProcesses(cx);
    await this.ensureConnected(cx);
  }

  async ensureConnected(cx, forceProc = null) {
    if (this.connecting || this.closed) return;
    const target = forceProc ?? pickTargetProcess(this.processes, this.matchContext());
    if (!target) {
      if (this.client) {
        this.client.close();
        this.client = null;
        this.connectedPid = null;
        this.sessionState = createSessionState();
        this.publishStatus();
      }
      cx.notify();
      return;
    }
    if (this.client && !this.client.closed && this.connectedPid === target.pid && !forceProc) {
      return;
    }
    this.connecting = true;
    this.error = null;
    cx.notify();

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
      this.connectedPid = null;
      if (err && !this.error) this.error = err.message;
      this.publishStatus();
      cx.notify();
    });

    try {
      await client.connect(target);
      if (this.closed) {
        client.close();
        return;
      }
      this.client = client;
      this.connectedPid = target.pid;
      const snap = await client.sessionSubscribe(target.session_id, null, 80);
      this.sessionState = applySnapshot(createSessionState(), snap, { parentSessionId: null });
      this.scrollToBottom();
      try {
        this.capabilities = await client.capabilitiesList(target.session_id);
      } catch {
        this.capabilities = null;
      }
      this.error = null;
      this.publishStatus();
    } catch (err) {
      client.close();
      this.client = null;
      this.connectedPid = null;
      this.error = err?.message ?? String(err);
      this.publishStatus();
    } finally {
      this.connecting = false;
      if (!this.closed) cx.notify();
    }
  }

  scrollToBottom() {
    try {
      this.scroll?.scroll_to_bottom?.();
    } catch {}
  }

  async subscribeTo(sessionId, parentSessionId, cx) {
    if (!this.client || this.client.closed || !sessionId) return;
    try {
      const snap = await this.client.sessionSubscribe(sessionId, null, 80);
      this.sessionState = applySnapshot(createSessionState(), snap, { parentSessionId });
      this.scrollToBottom();
      this.publishStatus();
      cx.notify();
    } catch (err) {
      this.error = err?.message ?? String(err);
      cx.notify();
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
      this.flashError(err);
    } finally {
      this.loadingHistory = false;
      if (!this.closed) cx.notify();
    }
  }

  flashError(err) {
    const msg = err?.message ?? String(err);
    this.flash = msg;
    notify({ title: "Mizar", body: msg, level: "error" });
  }

  async submitComposer(cx) {
    const sid = this.sessionState.session?.id;
    const text = this.composer.value().trim();
    if (!this.client || !sid || !text) return;
    try {
      this.composer.set_value("");
      this.draft = "";
      await this.client.turnSubmit(sid, text, this.submitMode);
      this.scrollToBottom();
      cx.notify();
    } catch (err) {
      this.composer.set_value(text);
      this.draft = text;
      this.flashError(err);
      cx.notify();
    }
  }

  async cancelTurn(cx) {
    const sid = this.sessionState.session?.id;
    if (!this.client || !sid) return;
    try {
      await this.client.turnCancel(sid);
      cx.notify();
    } catch (err) {
      this.flashError(err);
    }
  }

  async resolveInteraction(reqId, decision, cx) {
    if (!this.client) return;
    try {
      const res = await this.client.interactionResolve(reqId, decision);
      if (res && !res.ok) {
        this.flash = res.reason ?? "already resolved";
      }
      cx.notify();
    } catch (err) {
      this.flashError(err);
    }
  }

  async cycleEffort(cx) {
    const sid = this.sessionState.session?.id;
    if (!this.client || !sid) return;
    const cur = String(this.sessionState.config?.reasoning_effort ?? "medium").toLowerCase();
    const idx = EFFORTS.indexOf(cur);
    const next = EFFORTS[(idx + 1) % EFFORTS.length];
    try {
      const res = await this.client.sessionConfig(sid, { reasoning_effort: next });
      if (res?.config) this.sessionState = { ...this.sessionState, config: res.config, context: res.context ?? this.sessionState.context };
      cx.notify();
    } catch (err) {
      this.flashError(err);
    }
  }

  async toggleApprovalMode(cx) {
    const sid = this.sessionState.session?.id;
    if (!this.client || !sid) return;
    const cur = this.sessionState.config?.approval_mode === "ask" ? "ask" : "auto";
    const next = cur === "ask" ? "auto" : "ask";
    try {
      const res = await this.client.sessionConfig(sid, { approval_mode: next });
      if (res?.config) this.sessionState = { ...this.sessionState, config: res.config };
      cx.notify();
    } catch (err) {
      this.flashError(err);
    }
  }

  async switchModel(provider, model, cx) {
    const sid = this.sessionState.session?.id;
    if (!this.client || !sid) return;
    try {
      const res = await this.client.sessionConfig(sid, { provider, model });
      if (res?.config) this.sessionState = { ...this.sessionState, config: res.config, context: res.context ?? this.sessionState.context };
      this.drawer = null;
      this.publishStatus();
      cx.notify();
    } catch (err) {
      this.flashError(err);
    }
  }

  async openHistory(cx) {
    if (this.drawer === "history") {
      this.drawer = null;
      cx.notify();
      return;
    }
    this.drawer = "history";
    if (this.client) {
      try {
        const res = await this.client.sessionList({ cwd: this.sessionState.session?.cwd ?? null, limit: 25 });
        this.historyItems = res.sessions ?? [];
      } catch (err) {
        this.flashError(err);
      }
    }
    cx.notify();
  }

  async openTree(cx) {
    if (this.drawer === "tree") {
      this.drawer = null;
      cx.notify();
      return;
    }
    this.drawer = "tree";
    const sid = this.sessionState.session?.id;
    if (this.client && sid) {
      try {
        const res = await this.client.sessionTree(sid);
        this.treeEntries = res.entries ?? [];
      } catch (err) {
        this.flashError(err);
      }
    }
    cx.notify();
  }

  async forkAt(seq, cx) {
    const sid = this.sessionState.session?.id;
    if (!this.client || !sid) return;
    try {
      const res = await this.client.sessionFork(sid, seq);
      if (res?.session?.id) {
        notify({ title: "Mizar", body: `Forked branch ${res.session.id.slice(0, 8)} @ seq ${seq}`, level: "success" });
        await this.subscribeTo(res.session.id, null, cx);
      }
    } catch (err) {
      this.flashError(err);
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
      this.flashError(err);
    }
  }

  pillButton(t, id, label, active, onClick) {
    return h_flex()
      .id(id)
      .h(22)
      .px(8)
      .items_center()
      .rounded(6)
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

  renderStatusDot(t, status) {
    if (status === "streaming" || status === "working") {
      return svg(SPINNER_ICON).size(12).flex_none().text_color(t.working).spin(900);
    }
    const color = status === "waiting_approval" ? t.blocked : this.client ? t.idle : t.dim;
    return div().size(7).flex_none().rounded_full().bg(color);
  }

  renderHeader(t, cx) {
    const s = this.sessionState;
    const title = s.session?.title || (s.session?.id ? `Session ${s.session.id.slice(0, 8)}` : "Mizar");
    const ctxText = s.context?.max_tokens
      ? `${fmtTokens(s.context.used_tokens)} / ${fmtTokens(s.context.max_tokens)}`
      : `${fmtTokens(s.context?.used_tokens)} tok`;
    const modelLabel = s.config?.model ? `${s.config.provider ?? ""}${s.config.provider ? "/" : ""}${s.config.model}` : "default model";
    const effortLabel = s.config?.reasoning_effort ?? "default";
    const approvalLabel = s.config?.approval_mode === "ask" ? "ask" : "auto";

    return v_flex()
      .flex_none()
      .px(10)
      .py(8)
      .gap(6)
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(7)
          .items_center()
          .child(svg(MOD_ICON).size(14).flex_none().text_color(t.accent))
          .child(this.renderStatusDot(t, s.state))
          .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(title))
          .child(div().flex_none().text_size(10.5).text_color(t.dim).child(ctxText))
          .child(this.pillButton(t, "mz-proc-btn", this.connectedPid ? `pid:${this.connectedPid}` : `${this.processes.length} live`, this.drawer === "processes", () => {
            this.drawer = this.drawer === "processes" ? null : "processes";
            this.refreshProcesses(cx);
            cx.notify();
          }))
          .child(this.pillButton(t, "mz-open-card", "Card", false, () => {
            const p = panes().find((x) => x.focused) ?? panes().find((x) => !x.mod);
            run("pane.split", {
              direction: "right",
              ...(p?.pane ? { pane: p.pane } : {}),
              mod: "mayonaka-mizar",
              props: this.connectedPid ? { pid: this.connectedPid } : {},
            });
          })),
      )
      .child(
        h_flex()
          .gap(5)
          .items_center()
          .when(Boolean(this.client), (el) => el
            .child(this.pillButton(t, "mz-model-btn", truncateText(modelLabel, 24), this.drawer === "models", () => {
              this.drawer = this.drawer === "models" ? null : "models";
              cx.notify();
            }))
            .child(this.pillButton(t, "mz-effort-btn", effortLabel, false, () => this.cycleEffort(cx)))
            .child(this.pillButton(t, "mz-approval-btn", approvalLabel, s.config?.approval_mode === "ask", () => this.toggleApprovalMode(cx)))
            .child(this.pillButton(t, "mz-hist-btn", "History", this.drawer === "history", () => this.openHistory(cx)))
            .child(this.pillButton(t, "mz-tree-btn", "Tree", this.drawer === "tree", () => this.openTree(cx)))),
      );
  }

  renderDrawer(t, cx) {
    if (!this.drawer) return null;
    if (this.drawer === "processes") {
      return v_flex()
        .flex_none()
        .max_h(190)
        .overflow_y_scroll()
        .p(8)
        .gap(4)
        .bg(t.popover)
        .border_b(1)
        .border_color(t.border)
        .child(div().text_size(11).font_semibold().text_color(t.muted).child("Live Mizar processes (~/.mizar/run)"))
        .when(this.processes.length === 0, (el) => el.child(div().text_size(11.5).text_color(t.dim).child("No running Mizar sessions found.")))
        .children(this.processes.map((proc) => h_flex()
          .id(`mz-p-${proc.pid}`)
          .px(8)
          .py(5)
          .gap(8)
          .rounded(6)
          .cursor_pointer()
          .bg(proc.pid === this.connectedPid ? t.selected : t.surface)
          .hover((s) => s.bg(t.hover))
          .on_click(() => {
            this.manualPid = proc.pid;
            this.drawer = null;
            this.ensureConnected(cx, proc);
          })
          .child(div().text_size(11.5).font_medium().text_color(t.foreground).child(`PID ${proc.pid}`))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(shortHome(proc.cwd)))
          .child(div().text_size(10.5).text_color(t.dim).child(proc.session_id.slice(0, 8)))));
    }
    if (this.drawer === "models") {
      const providers = this.capabilities?.providers ?? [];
      return v_flex()
        .flex_none()
        .max_h(220)
        .overflow_y_scroll()
        .p(8)
        .gap(4)
        .bg(t.popover)
        .border_b(1)
        .border_color(t.border)
        .child(div().text_size(11).font_semibold().text_color(t.muted).child("Select model"))
        .children(providers.flatMap((prov) => (prov.models ?? []).map((m) => h_flex()
          .id(`mz-m-${prov.id}-${m.id}`)
          .px(8)
          .py(4)
          .gap(8)
          .rounded(6)
          .cursor_pointer()
          .bg(this.sessionState.config?.model === m.id ? t.selected : t.surface)
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.switchModel(prov.id, m.id, cx))
          .child(div().flex_1().truncate().text_size(11.5).text_color(t.foreground).child(`${prov.id}/${m.id}`)))));
    }
    if (this.drawer === "history") {
      return v_flex()
        .flex_none()
        .max_h(220)
        .overflow_y_scroll()
        .p(8)
        .gap(4)
        .bg(t.popover)
        .border_b(1)
        .border_color(t.border)
        .child(div().text_size(11).font_semibold().text_color(t.muted).child("Workspace sessions"))
        .children(this.historyItems.map((h) => h_flex()
          .id(`mz-h-${h.id}`)
          .px(8)
          .py(5)
          .gap(8)
          .rounded(6)
          .cursor_pointer()
          .bg(h.id === this.sessionState.session?.id ? t.selected : t.surface)
          .hover((s) => s.bg(t.hover))
          .on_click(() => {
            const owner = h.active_writer_pid ? this.processes.find((p) => p.pid === h.active_writer_pid) : null;
            if (owner) {
              this.manualPid = owner.pid;
              this.drawer = null;
              this.ensureConnected(cx, owner);
            } else {
              notify({ title: "Mizar", body: `Historical session ${h.id.slice(0, 8)} has no live process; run \`mizar -r ${h.id}\` to edit.`, level: "info" });
            }
          })
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(h.title || h.id.slice(0, 12)))
          .when(Boolean(h.active_writer_pid), (el) => el.child(div().text_size(10.5).text_color(t.accent).child(`pid:${h.active_writer_pid}`)))
          .child(div().text_size(10.5).text_color(t.dim).child(`${h.event_count} ev`))));
    }
    if (this.drawer === "tree") {
      return v_flex()
        .flex_none()
        .max_h(220)
        .overflow_y_scroll()
        .p(8)
        .gap(4)
        .bg(t.popover)
        .border_b(1)
        .border_color(t.border)
        .child(div().text_size(11).font_semibold().text_color(t.muted).child("Session tree"))
        .children(this.treeEntries.map((ent, idx) => h_flex()
          .id(`mz-tr-${idx}`)
          .pl(8 + (ent.depth ?? 0) * 14)
          .pr(8)
          .py(4)
          .gap(6)
          .items_center()
          .rounded(6)
          .bg(t.surface)
          .hover((s) => s.bg(t.hover))
          .child(div().px(5).py(1).rounded(4).bg(t.chrome).text_size(10).text_color(t.accent).child(ent.kind_tag || "event"))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.foreground).child(ent.summary || `#${ent.seq}`))
          .child(div().text_size(10.5).text_color(t.dim).child(`#${ent.seq}`))
          .when(Boolean(this.client && ent.can_fork), (el) => el.child(
            this.pillButton(t, `mz-tr-fk-${ent.seq}-${idx}`, "Fork", false, () => this.forkAt(ent.seq, cx)),
          ))));
    }
    return null;
  }

  renderApprovals(t, cx) {
    const items = this.sessionState.pendingInteractions;
    if (!items.length) return null;
    return v_flex()
      .flex_none()
      .p(8)
      .gap(6)
      .bg(t.raised)
      .border_b(1)
      .border_color(t.blocked)
      .children(items.map((req) => v_flex()
        .id(`mz-app-${req.request_id}`)
        .p(8)
        .gap(6)
        .rounded(8)
        .border_1()
        .border_color(t.blocked)
        .bg(t.background)
        .child(h_flex().gap(6).items_center()
          .child(div().size(7).rounded_full().bg(t.blocked))
          .child(div().text_size(12).font_semibold().text_color(t.foreground).child(`Approval: ${req.tool}`))
          .child(div().flex_1().truncate().text_size(11).text_color(t.muted).child(req.summary ?? "")))
        .child(div().text_size(11).text_color(t.dim).child(truncateText(JSON.stringify(req.args ?? {}), 260)))
        .child(h_flex().gap(6)
          .child(this.pillButton(t, `mz-ok1-${req.request_id}`, "Allow once", true, () => this.resolveInteraction(req.request_id, "allow_once", cx)))
          .child(this.pillButton(t, `mz-oks-${req.request_id}`, "Allow session", false, () => this.resolveInteraction(req.request_id, "allow_session", cx)))
          .child(this.pillButton(t, `mz-deny-${req.request_id}`, "Deny", false, () => this.resolveInteraction(req.request_id, "deny", cx))))));
  }

  renderSubagents(t, cx) {
    const { subagents, parentSessionId, session } = this.sessionState;
    if (!subagents.length && !parentSessionId) return null;
    return h_flex()
      .flex_none()
      .px(10)
      .py(6)
      .gap(6)
      .items_center()
      .overflow_x_scrollbar()
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .when(Boolean(parentSessionId), (el) => el.child(this.pillButton(t, "mz-back-parent", "← Parent", true, () => {
        this.subscribeTo(parentSessionId, null, cx);
      })))
      .children(subagents.map((sub) => this.pillButton(
        t,
        `mz-sub-${sub.child_session_id}`,
        `${sub.name} (${sub.status}${sub.current_step ? ` · ${sub.current_step}` : ""})`,
        session?.id === sub.child_session_id,
        () => this.subscribeTo(sub.child_session_id, session?.id ?? parentSessionId, cx),
      )));
  }

  renderToolMeta(t, item, cx) {
    const m = item.meta;
    const expanded = this.expandedTools.has(item.seq);
    const toggle = () => {
      if (expanded) this.expandedTools.delete(item.seq);
      else this.expandedTools.add(item.seq);
      cx.notify();
    };
    let headline = item.name;
    let subtitle = "";
    let body = item.content ?? "";
    if (m?.kind === "diff") {
      headline = `edit ${m.path ?? ""}`;
      subtitle = `+${m.added ?? 0} / -${m.removed ?? 0}`;
      if (m.diff) body = m.diff;
    } else if (m?.kind === "write") {
      headline = `write ${m.path ?? ""}`;
      subtitle = `${m.bytes ?? 0} B · ${m.lines ?? 0} lines`;
    } else if (m?.kind === "bash") {
      headline = `$ ${truncateText(m.command ?? "", 48)}`;
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
      .p(7)
      .gap(4)
      .rounded(7)
      .border_1()
      .border_color(item.isError ? t.blocked : t.border)
      .bg(t.surface)
      .child(h_flex().gap(8).items_center().cursor_pointer().on_click(toggle)
        .child(div().text_size(11.5).font_medium().text_color(item.isError ? t.blocked : t.foreground).child(headline))
        .child(div().flex_1().truncate().text_size(10.5).text_color(t.dim).child(subtitle))
        .child(div().text_size(10.5).text_color(t.muted).child(expanded ? "Hide" : "Show")))
      .when(expanded && Boolean(body), (el) => el.child(div().text_size(11).text_color(t.muted).child(truncateText(body, 2000))));
  }

  renderEventRow(t, ev, cx) {
    const item = summarizeCommittedEvent(ev);
    const forkPill = this.client && item.seq
      ? div().id(`mz-fk-${item.seq}`).px(5).py(1).rounded(4).cursor_pointer().text_size(10).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => this.forkAt(item.seq, cx))
          .child("Fork")
      : null;

    if (item.kind === "user") {
      return v_flex().p(8).gap(4).rounded(8).bg(t.selected).border_1().border_color(t.border)
        .child(h_flex().items_center().child(div().flex_1().text_size(10.5).font_semibold().text_color(t.accent).child("You")).when(Boolean(forkPill), (el) => el.child(forkPill)))
        .child(div().text_size(12.5).text_color(t.foreground).child(item.text));
    }
    if (item.kind === "assistant") {
      const { reasoning, text, toolCalls } = flattenTextBlocks(item.blocks);
      const showReason = this.expandedReasoning.has(item.seq);
      return v_flex().p(8).gap(6).rounded(8).bg(t.background).border_1().border_color(t.border)
        .child(h_flex().items_center().gap(6)
          .child(div().flex_1().text_size(10.5).font_semibold().text_color(t.muted).child("Mizar"))
          .when(Boolean(reasoning), (el) => el.child(this.pillButton(t, `mz-rsn-${item.seq}`, showReason ? "Hide thinking" : "Thinking", showReason, () => {
            if (showReason) this.expandedReasoning.delete(item.seq);
            else this.expandedReasoning.add(item.seq);
            cx.notify();
          })))
          .when(Boolean(forkPill), (el) => el.child(forkPill)))
        .when(showReason && Boolean(reasoning), (el) => el.child(div().p(6).rounded(6).bg(t.chrome).text_size(11).text_color(t.dim).child(truncateText(reasoning, 1600))))
        .when(Boolean(text), (el) => el.child(TextView.markdown(`mz-md-${item.seq}`, text).selectable(true).raw_html(false)))
        .when(toolCalls.length > 0, (el) => el.child(h_flex().gap(4).children(toolCalls.map((tc, i) =>
          div().px(6).py(2).rounded(5).bg(t.surface).text_size(10.5).text_color(t.muted).child(`⚙ ${tc.name ?? `call-${i + 1}`}`)))));
    }
    if (item.kind === "tool-result") {
      return this.renderToolMeta(t, item, cx);
    }
    if (item.kind === "bash-execution") {
      return v_flex().p(7).gap(4).rounded(7).bg(t.surface).border_1().border_color(t.border)
        .child(div().text_size(11.5).font_medium().text_color(t.foreground).child(`! ${item.command} (exit ${item.exitCode ?? "?"})`))
        .when(Boolean(item.output), (el) => el.child(div().text_size(11).text_color(t.muted).child(truncateText(item.output, 600))));
    }
    if (item.kind === "approval") {
      return div().px(8).py(4).rounded(6).bg(t.chrome).text_size(11).text_color(t.muted)
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
      return div().px(6).py(3).text_size(10.5).text_color(item.error ? t.blocked : t.dim).child(parts.join(" · "));
    }
    if (item.kind === "compaction") {
      return div().px(8).py(5).rounded(6).bg(t.chrome).text_size(11).text_color(t.dim)
        .child(`Compacted history up to seq ${item.firstKeptSeq}${item.tokensBefore && item.tokensAfter ? ` (${fmtTokens(item.tokensBefore)} → ${fmtTokens(item.tokensAfter)})` : ""}`);
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
      return h_flex().p(8).gap(6).items_center().rounded(8).bg(t.background).border_1().border_color(t.accent)
        .child(svg(SPINNER_ICON).size(12).text_color(t.working).spin(900))
        .child(div().text_size(11.5).text_color(t.muted).child(`Turn ${at.turn} · Step ${at.step} thinking…`));
    }
    return v_flex().p(8).gap(6).rounded(8).bg(t.background).border_1().border_color(t.accent)
      .child(h_flex().gap(6).items_center()
        .child(svg(SPINNER_ICON).size(12).text_color(t.working).spin(900))
        .child(div().text_size(10.5).font_semibold().text_color(t.accent).child(`Streaming · Turn ${at.turn} Step ${at.step}`)))
      .when(Boolean(at.reasoning), (el) => el.child(div().p(6).rounded(6).bg(t.chrome).text_size(11).text_color(t.dim).child(truncateText(at.reasoning, 1200))))
      .when(Boolean(at.text), (el) => el.child(TextView.markdown("mz-live-md", at.text).selectable(true).raw_html(false)))
      .children((at.running_tools ?? []).map((rt) => v_flex().p(6).gap(3).rounded(6).bg(t.surface).border_1().border_color(t.border)
        .child(div().text_size(11).font_medium().text_color(t.working).child(`Running ${rt.name}…`))
        .when(Boolean(rt.output_tail), (el) => el.child(div().text_size(10.5).text_color(t.muted).child(truncateText(rt.output_tail, 600))))));
  }

  renderQueueStrip(t, cx) {
    const q = this.sessionState.queuedInputs;
    if (!q.length) return null;
    const sid = this.sessionState.session?.id;
    return v_flex().flex_none().px(10).py(6).gap(4).bg(t.chrome).border_t(1).border_color(t.border)
      .child(h_flex().items_center().child(div().flex_1().text_size(10.5).font_semibold().text_color(t.muted).child(`Queued (${q.length})`))
        .child(this.pillButton(t, "mz-q-pop", "Pop all", false, () => this.popAllQueue(cx))))
      .children(q.map((item) => h_flex().gap(6).items_center()
        .child(div().flex_1().truncate().text_size(11).text_color(t.foreground).child(item.text))
        .child(this.pillButton(t, `mz-q-rm-${item.id}`, "×", false, () => this.client?.queueRemove(sid, item.id)))));
  }

  renderComposer(t, cx) {
    const busy = this.sessionState.state !== "idle";
    return v_flex().flex_none().p(8).gap(6).bg(t.chrome).border_t(1).border_color(t.border)
      .child(
        Textarea.new(this.composer)
          .w_full()
          .p(8)
          .rounded(8)
          .border_1()
          .border_color(this.composerFocused ? t.accent : t.input)
          .bg(t.background)
          .text_size(12.5)
          .text_color(t.foreground),
      )
      .child(
        h_flex().gap(6).items_center()
          .child(this.pillButton(t, "mz-mode-send", "Send", this.submitMode === "send", () => { this.submitMode = "send"; cx.notify(); }))
          .child(this.pillButton(t, "mz-mode-steer", "Steer", this.submitMode === "steer", () => { this.submitMode = "steer"; cx.notify(); }))
          .child(this.pillButton(t, "mz-mode-queue", "Queue", this.submitMode === "queue", () => { this.submitMode = "queue"; cx.notify(); }))
          .child(div().flex_1())
          .when(busy, (el) => el.child(this.pillButton(t, "mz-stop", "Stop", true, () => this.cancelTurn(cx))))
          .child(h_flex()
            .id("mz-submit")
            .h(24)
            .px(10)
            .items_center()
            .rounded(6)
            .cursor_pointer()
            .bg(t.solid)
            .text_color(t.solid_foreground)
            .text_size(11.5)
            .font_medium()
            .hover((s) => s.opacity(0.88))
            .on_click(() => this.submitComposer(cx))
            .child("Send")),
      );
  }

  render(cx) {
    const t = theme();
    const visibleEvents = (this.sessionState.events ?? []).filter((e) => e.visibility !== "log-only" || e.kind === "approval" || e.kind === "turn-end" || e.kind === "turn-notice");
    const activeTurnEl = this.renderActiveTurn(t);

    return v_flex()
      .id("mayonaka-mizar")
      .track_focus(this.handle)
      .size_full()
      .min_h(0)
      .bg(t.background)
      .border_1()
      .border_color(t.border)
      .rounded(10)
      .overflow_hidden()
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.drawer) {
            this.drawer = null;
            cx.stop_propagation();
            cx.notify();
          } else if (this.sessionState.state !== "idle") {
            this.cancelTurn(cx);
            cx.stop_propagation();
          }
        }
      })
      .child(this.renderHeader(t, cx))
      .when(Boolean(this.drawer), (el) => el.child(this.renderDrawer(t, cx)))
      .when(Boolean(this.error), (el) => el.child(h_flex().px(10).py(6).bg(t.raised).border_b(1).border_color(t.blocked).gap(8)
        .child(div().flex_1().text_size(11.5).text_color(t.blocked).child(this.error))
        .child(this.pillButton(t, "mz-retry", "Retry", false, () => this.refreshAndFollow(cx)))))
      .child(this.renderApprovals(t, cx) ?? div())
      .child(this.renderSubagents(t, cx) ?? div())
      .child(
        v_flex()
          .id("mizar-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scroll()
          .track_scroll(this.scroll)
          .p(10)
          .gap(8)
          .when(!this.client && !this.connecting, (el) => el.child(
            v_flex().p(14).gap(8).rounded(8).bg(t.surface).border_1().border_color(t.border)
              .child(div().text_size(13).font_semibold().text_color(t.foreground).child("No active Mizar session"))
              .child(div().text_size(11.5).text_color(t.muted).child("Launch `mizar` in any terminal pane; this panel attaches automatically via ~/.mizar/run/."))
              .child(h_flex().child(this.pillButton(t, "mz-scan", "Scan ~/.mizar/run", false, () => this.refreshAndFollow(cx)))),
          ))
          .when(this.sessionState.hasMoreHistory, (el) => el.child(
            h_flex().justify_center().child(this.pillButton(t, "mz-load-more", this.loadingHistory ? "Loading…" : "Load earlier events", false, () => this.loadEarlier(cx))),
          ))
          .children(visibleEvents.map((ev) => this.renderEventRow(t, ev, cx)).filter(Boolean))
          .when(Boolean(activeTurnEl), (el) => el.child(activeTurnEl)),
      )
      .child(this.renderQueueStrip(t, cx) ?? div())
      .child(this.renderComposer(t, cx));
  }
}
