// Pure ESM JSON-RPC 2.0 client, process matcher, and session state reducer for Mizar.
// Shared between the Herdr GPUI view (main.js) and Node.js integration tests (rpc.test.mjs).
import { Buffer } from "buffer";

const MAX_OUTPUT_TAIL_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(host) {
  return typeof host === "string" && LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

export function parseTcpAddr(tcpAddr) {
  if (typeof tcpAddr !== "string") return null;
  const raw = tcpAddr.trim();
  if (!raw) return null;
  let host = "";
  let portStr = "";
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]:");
    if (close <= 1) return null;
    host = raw.slice(1, close);
    portStr = raw.slice(close + 2);
  } else {
    const colon = raw.lastIndexOf(":");
    if (colon <= 0 || raw.indexOf(":") !== colon) return null;
    host = raw.slice(0, colon);
    portStr = raw.slice(colon + 1);
  }
  if (!isLoopbackHost(host)) return null;
  if (!/^\d+$/.test(portStr)) return null;
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: host === "[::1]" ? "::1" : host, port };
}

function normPath(p) {
  if (typeof p !== "string" || !p) return "";
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

function pathScore(procCwd, targetCwd) {
  const a = normPath(procCwd);
  const b = normPath(targetCwd);
  if (!a || !b) return 0;
  if (a === b) return 300;
  if (a.startsWith(b + "/") || b.startsWith(a + "/")) return 150;
  return 0;
}

export async function scanRunDir(runDir, { readdir, readFile }) {
  let names;
  try {
    names = await readdir(runDir);
  } catch {
    return [];
  }
  const items = [];
  for (const name of names) {
    if (!name.startsWith("p-") || !name.endsWith(".json")) continue;
    let raw;
    try {
      raw = await readFile(`${normPath(runDir)}/${name}`, "utf8");
    } catch {
      continue;
    }
    let meta;
    try {
      meta = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!meta || typeof meta.pid !== "number" || !meta.session_id) continue;
    const tcp = parseTcpAddr(meta.tcp_addr);
    if (!tcp || typeof meta.rpc_token !== "string" || !meta.rpc_token) continue;
    items.push({ ...meta, tcpHost: tcp.host, tcpPort: tcp.port });
  }
  items.sort((a, b) => (b.started_at_ms ?? 0) - (a.started_at_ms ?? 0) || (b.pid ?? 0) - (a.pid ?? 0));
  return items;
}

export function pickTargetProcess(processes, context = {}) {
  if (!Array.isArray(processes) || processes.length === 0) return null;
  if (context.preferPid != null) {
    const exactPid = processes.find((p) => p.pid === context.preferPid);
    if (exactPid) return exactPid;
  }
  if (context.focusedPaneId) {
    const byPane = processes.find((p) => p.herdr_pane_id && p.herdr_pane_id === context.focusedPaneId);
    if (byPane) return byPane;
  }
  const cwdCandidates = [context.focusedCwd, context.activeTabCwd, context.activeSpaceFolder].filter(Boolean);
  let best = null;
  let bestRank = -1;
  for (const proc of processes) {
    let rank = 0;
    for (let i = 0; i < cwdCandidates.length; i++) {
      const s = pathScore(proc.cwd, cwdCandidates[i]);
      if (s > 0) {
        rank = Math.max(rank, s + (cwdCandidates.length - i) * 20);
      }
    }
    if (rank > bestRank || (rank === bestRank && best && (proc.started_at_ms ?? 0) > (best.started_at_ms ?? 0))) {
      best = proc;
      bestRank = rank;
    }
  }
  return best ?? processes[0];
}

export class NdjsonDecoder {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (part.length === 0) return [];
    this.buf = this.buf.length ? Buffer.concat([this.buf, part]) : part;
    const lines = [];
    let start = 0;
    while (true) {
      const nl = this.buf.indexOf(0x0a, start);
      if (nl === -1) break;
      const line = this.buf.subarray(start, nl).toString("utf8").replace(/\r$/, "").trim();
      if (line) lines.push(line);
      start = nl + 1;
    }
    if (start > 0) {
      this.buf = start < this.buf.length ? Buffer.from(this.buf.subarray(start)) : Buffer.alloc(0);
    }
    return lines;
  }
}

function capUtf8Tail(str, maxBytes) {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start).toString("utf8");
}

export class MizarRpcClient {
  constructor({ connectTcp, setTimer = null, clearTimer = null }) {
    if (typeof connectTcp !== "function") {
      throw new Error("MizarRpcClient requires connectTcp(host, port)");
    }
    this.connectTcp = connectTcp;
    this.setTimer = setTimer ?? (typeof globalThis.setTimeout === "function"
      ? (ms, fn) => globalThis.setTimeout(fn, ms)
      : null);
    this.clearTimer = clearTimer ?? ((handle) => {
      if (!handle) return;
      if (typeof handle.cancel === "function") handle.cancel();
      else if (typeof globalThis.clearTimeout === "function") globalThis.clearTimeout(handle);
    });
    this.socket = null;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationListeners = new Set();
    this.closeListeners = new Set();
    this.decoder = new NdjsonDecoder();
    this.meta = null;
  }

  onNotification(fn) {
    this.notificationListeners.add(fn);
    return () => this.notificationListeners.delete(fn);
  }

  onClose(fn) {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  async connect(meta) {
    const tcp = parseTcpAddr(meta?.tcp_addr);
    if (!tcp) {
      throw new Error(`Refusing non-loopback or invalid Mizar tcp_addr: ${meta?.tcp_addr}`);
    }
    if (!meta?.rpc_token) {
      throw new Error("Missing Mizar rpc_token in process metadata");
    }
    this.meta = meta;
    this.closed = false;
    this.socket = await this.connectTcp(tcp.host, tcp.port);
    this._startReadLoop();
    const auth = await this.call("auth.hello", { token: meta.rpc_token }, 5000);
    if (!auth?.ok) {
      this.close(new Error("Mizar auth.hello rejected"));
      throw new Error("Mizar auth.hello rejected");
    }
    return this;
  }

  async _startReadLoop() {
    try {
      while (!this.closed && this.socket) {
        const chunk = await this.socket.read(64 * 1024);
        if (chunk === null || chunk === undefined) break;
        const lines = this.decoder.push(chunk);
        for (const line of lines) {
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg && msg.id !== undefined && msg.id !== null) {
            const waiter = this.pending.get(msg.id);
            if (waiter) {
              this.pending.delete(msg.id);
              this.clearTimer(waiter.timer);
              if (msg.error) {
                const err = new Error(msg.error.message ?? "JSON-RPC error");
                err.code = msg.error.code;
                err.data = msg.error.data;
                waiter.reject(err);
              } else {
                waiter.resolve(msg.result);
              }
            }
          } else if (msg && typeof msg.method === "string") {
            for (const fn of this.notificationListeners) {
              try {
                fn(msg.method, msg.params ?? {});
              } catch {
                // Keep listener errors isolated from read loop.
              }
            }
          }
        }
      }
      this.close(null);
    } catch (err) {
      this.close(err instanceof Error ? err : new Error(String(err)));
    }
  }

  call(method, params = {}, timeoutMs = 15000) {
    if (this.closed || !this.socket) {
      return Promise.reject(new Error("Mizar RPC socket is closed"));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    return new Promise((resolve, reject) => {
      const timer = this.setTimer
        ? this.setTimer(timeoutMs, () => {
            if (this.pending.delete(id)) {
              reject(new Error(`RPC timeout calling ${method}`));
            }
          })
        : null;
      this.pending.set(id, { resolve, reject, timer });
      Promise.resolve(this.socket.write(payload)).catch((err) => {
        if (this.pending.delete(id)) {
          this.clearTimer(timer);
          reject(err);
        }
      });
    });
  }

  close(reason = null) {
    if (this.closed) return;
    this.closed = true;
    const sock = this.socket;
    this.socket = null;
    try {
      sock?.close();
    } catch {}
    const err = reason ?? new Error("Mizar RPC socket closed");
    for (const [id, waiter] of this.pending.entries()) {
      this.clearTimer(waiter.timer);
      waiter.reject(err);
      this.pending.delete(id);
    }
    for (const fn of this.closeListeners) {
      try {
        fn(reason);
      } catch {}
    }
  }

  sessionSubscribe(sessionId, afterSeq = null, limit = 80) {
    const params = { session_id: sessionId };
    if (afterSeq !== null && afterSeq !== undefined) params.after_seq = afterSeq;
    if (limit !== null && limit !== undefined) params.limit = limit;
    return this.call("session.subscribe", params);
  }
  turnSubmit(sessionId, text, mode = "send", attachments = []) {
    return this.call("turn.submit", { session_id: sessionId, text, mode, attachments });
  }
  turnCancel(sessionId) {
    return this.call("turn.cancel", { session_id: sessionId });
  }
  queueRemove(sessionId, id) {
    return this.call("queue.remove", { session_id: sessionId, id });
  }
  queuePopAll(sessionId) {
    return this.call("queue.pop_all", { session_id: sessionId });
  }
  interactionResolve(requestId, decision, note = null) {
    const params = { request_id: requestId, decision };
    if (note) params.note = note;
    return this.call("interaction.resolve", params);
  }
  sessionConfig(sessionId, patch = {}) {
    return this.call("session.config", { session_id: sessionId, ...patch });
  }
  sessionList(params = {}) {
    return this.call("session.list", params);
  }
  sessionEvents(sessionId, { beforeSeq = null, afterSeq = null, limit = 40 } = {}) {
    const params = { session_id: sessionId, limit };
    if (beforeSeq !== null && beforeSeq !== undefined) params.before_seq = beforeSeq;
    if (afterSeq !== null && afterSeq !== undefined) params.after_seq = afterSeq;
    return this.call("session.events", params);
  }
  sessionFork(sessionId, atSeq) {
    return this.call("session.fork", { session_id: sessionId, at_seq: atSeq });
  }
  sessionTree(sessionId) {
    return this.call("session.tree", { session_id: sessionId });
  }
  capabilitiesList(sessionId = null) {
    return this.call("capabilities.list", sessionId ? { session_id: sessionId } : {});
  }
  sessionNew(title = null) {
    return this.call("session.new", title ? { title } : {});
  }
  sessionSwitch(sessionId) {
    return this.call("session.switch", { session_id: sessionId });
  }
  sessionCompact(sessionId, focus = null) {
    const params = { session_id: sessionId };
    if (focus) params.focus = focus;
    return this.call("session.compact", params, 120000);
  }
  bashRun(sessionId, command, excludeFromContext = false) {
    return this.call(
      "bash.run",
      { session_id: sessionId, command, exclude_from_context: Boolean(excludeFromContext) },
      300000,
    );
  }
}

export function createSessionState() {
  return {
    session: null,
    state: "idle",
    config: { provider: null, model: null, reasoning_effort: null, approval_mode: "auto" },
    context: { used_tokens: 0, max_tokens: null },
    events: [],
    activeTurn: null,
    pendingInteractions: [],
    queuedInputs: [],
    subagents: [],
    subagentNotices: [],
    parentSessionId: null,
    hasMoreHistory: false,
    switchedTo: null,
  };
}

function mergeEventsAscending(existing, incoming) {
  const bySeq = new Map();
  for (const ev of existing ?? []) bySeq.set(ev.seq, ev);
  for (const ev of incoming ?? []) bySeq.set(ev.seq, ev);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function applySnapshot(prev, snapshot, opts = {}) {
  const base = prev ?? createSessionState();
  const events = mergeEventsAscending([], snapshot.events ?? []);
  const earliest = events.length > 0 ? events[0].seq : 1;
  return {
    ...base,
    session: snapshot.session ?? null,
    state: snapshot.state ?? "idle",
    config: snapshot.config ?? base.config,
    context: snapshot.context ?? base.context,
    events,
    activeTurn: snapshot.active_turn ?? null,
    pendingInteractions: [...(snapshot.pending_interactions ?? [])],
    queuedInputs: [...(snapshot.queued_inputs ?? [])],
    subagents: [...(snapshot.subagents ?? [])],
    parentSessionId: opts.parentSessionId !== undefined ? opts.parentSessionId : base.parentSessionId,
    hasMoreHistory: earliest > 1,
    switchedTo: null,
  };
}

export function prependPagedEvents(stateObj, olderEvents, hasMore) {
  return {
    ...stateObj,
    events: mergeEventsAscending(olderEvents ?? [], stateObj.events),
    hasMoreHistory: Boolean(hasMore),
  };
}

export function applyNotification(stateObj, method, params) {
  const targetSid = stateObj.session?.id;
  if (method === "session.switched") {
    return {
      ...stateObj,
      switchedTo: params.new_session_id ?? null,
    };
  }
  if (method === "interaction.requested") {
    if (params.session_id && targetSid && params.session_id !== targetSid) return stateObj;
    const filtered = stateObj.pendingInteractions.filter((it) => it.request_id !== params.request_id);
    return {
      ...stateObj,
      state: "waiting_approval",
      pendingInteractions: [...filtered, params],
    };
  }
  if (method === "interaction.resolved") {
    if (params.session_id && targetSid && params.session_id !== targetSid) return stateObj;
    const nextPending = stateObj.pendingInteractions.filter((it) => it.request_id !== params.request_id);
    return {
      ...stateObj,
      state: nextPending.length === 0 && stateObj.state === "waiting_approval"
        ? (stateObj.activeTurn ? "streaming" : "idle")
        : stateObj.state,
      pendingInteractions: nextPending,
    };
  }

  if (params.session_id && targetSid && params.session_id !== targetSid) {
    return stateObj;
  }

  if (method === "turn.state") {
    let activeTurn = stateObj.activeTurn;
    if (params.state === "idle") {
      activeTurn = null;
    } else if (!activeTurn || activeTurn.turn !== params.turn || activeTurn.step !== params.step) {
      activeTurn = {
        turn: params.turn ?? 1,
        step: params.step ?? 1,
        reasoning: "",
        text: "",
        running_tools: activeTurn?.turn === params.turn ? [...(activeTurn.running_tools ?? [])] : [],
      };
    }
    return {
      ...stateObj,
      state: params.state ?? stateObj.state,
      activeTurn,
    };
  }

  if (method === "stream.delta") {
    const turn = params.turn ?? stateObj.activeTurn?.turn ?? 1;
    const step = params.step ?? stateObj.activeTurn?.step ?? 1;
    const cur = stateObj.activeTurn && stateObj.activeTurn.turn === turn
      ? {
          ...stateObj.activeTurn,
          step,
          running_tools: [...(stateObj.activeTurn.running_tools ?? [])],
        }
      : { turn, step, reasoning: "", text: "", running_tools: [] };
    const delta = params.delta ?? "";
    if (params.kind === "reasoning") {
      cur.reasoning = (cur.reasoning ?? "") + delta;
    } else if (params.kind === "text") {
      cur.text = (cur.text ?? "") + delta;
    } else if (params.kind === "tool_args" || params.kind === "tool_output") {
      const cid = params.call_id ?? "tool";
      const idx = cur.running_tools.findIndex((t) => t.call_id === cid);
      const entry = idx >= 0
        ? { ...cur.running_tools[idx] }
        : { call_id: cid, name: cid, arguments: "", output_tail: "" };
      if (params.kind === "tool_args") entry.arguments = (entry.arguments ?? "") + delta;
      else entry.output_tail = capUtf8Tail((entry.output_tail ?? "") + delta, MAX_OUTPUT_TAIL_BYTES);
      if (idx >= 0) cur.running_tools[idx] = entry;
      else cur.running_tools.push(entry);
    }
    return {
      ...stateObj,
      state: stateObj.state === "idle" ? "streaming" : stateObj.state,
      activeTurn: cur,
    };
  }

  if (method === "event.committed") {
    const nextEvents = mergeEventsAscending(stateObj.events, [params]);
    let activeTurn = stateObj.activeTurn;
    let context = stateObj.context;
    const payload = params.payload ?? {};
    const kind = params.kind ?? payload.type;

    if (kind === "assistant") {
      const u = payload.usage;
      if (u && typeof u === "object") {
        const used = Number(u.inputTokens ?? u.input_tokens ?? 0)
          + Number(u.cacheReadTokens ?? u.cache_read_tokens ?? 0)
          + Number(u.cacheWriteTokens ?? u.cache_write_tokens ?? 0)
          + Number(u.outputTokens ?? u.output_tokens ?? 0);
        if (used > 0) context = { ...context, used_tokens: used };
      }
      if (activeTurn) {
        activeTurn = { ...activeTurn, text: "", reasoning: "" };
      }
    } else if (kind === "tool-call") {
      const d = payload.detail ?? payload;
      const cid = d.call_id;
      if (cid) {
        const cur = activeTurn ?? { turn: d.turn ?? 1, step: d.step ?? 1, reasoning: "", text: "", running_tools: [] };
        const tools = [...(cur.running_tools ?? [])];
        const idx = tools.findIndex((t) => t.call_id === cid);
        const item = { call_id: cid, name: d.name ?? "tool", arguments: d.arguments ?? "", output_tail: tools[idx]?.output_tail ?? "" };
        if (idx >= 0) tools[idx] = item;
        else tools.push(item);
        activeTurn = { ...cur, running_tools: tools };
      }
    } else if (kind === "tool-result") {
      const cid = payload.tool_call_id;
      if (activeTurn && cid) {
        activeTurn = {
          ...activeTurn,
          running_tools: (activeTurn.running_tools ?? []).filter((t) => t.call_id !== cid),
        };
      }
    } else if (kind === "turn-end") {
      activeTurn = null;
    }

    return {
      ...stateObj,
      events: nextEvents,
      context,
      activeTurn,
    };
  }

  if (method === "queue.updated") {
    return {
      ...stateObj,
      queuedInputs: [...(params.items ?? [])],
    };
  }

  if (method === "subagent.updated") {
    const task = params.task;
    if (!task) return stateObj;
    const filtered = stateObj.subagents.filter((t) => t.child_session_id !== task.child_session_id);
    const notices = params.notice
      ? [...stateObj.subagentNotices.slice(-9), { at: Date.now(), text: params.notice }]
      : stateObj.subagentNotices;
    return {
      ...stateObj,
      subagents: [...filtered, task].sort((a, b) => a.name.localeCompare(b.name)),
      subagentNotices: notices,
    };
  }

  return stateObj;
}

export function summarizeCommittedEvent(ev) {
  const payload = ev?.payload ?? {};
  const kind = ev?.kind ?? payload.type ?? "unknown";
  if (kind === "user") {
    return { kind: "user", seq: ev.seq, text: payload.text ?? "", imagesCount: payload.images?.length ?? 0 };
  }
  if (kind === "context-notice") {
    return { kind: "context-notice", seq: ev.seq, source: payload.source ?? "system", text: payload.text ?? "" };
  }
  if (kind === "assistant") {
    return { kind: "assistant", seq: ev.seq, blocks: Array.isArray(payload.blocks) ? payload.blocks : [], usage: payload.usage ?? null };
  }
  if (kind === "tool-result") {
    return {
      kind: "tool-result",
      seq: ev.seq,
      toolCallId: payload.tool_call_id ?? "",
      name: payload.name ?? "tool",
      content: payload.content ?? "",
      isError: Boolean(payload.is_error),
      meta: payload.meta ?? null,
    };
  }
  if (kind === "bash-execution") {
    return {
      kind: "bash-execution",
      seq: ev.seq,
      command: payload.command ?? "",
      output: payload.output ?? "",
      exitCode: payload.exit_code ?? null,
      cancelled: Boolean(payload.cancelled),
      excludeFromContext: Boolean(payload.exclude_from_context),
    };
  }
  if (kind === "compaction") {
    return {
      kind: "compaction",
      seq: ev.seq,
      summary: payload.summary ?? "",
      firstKeptSeq: payload.first_kept_seq ?? 0,
      tokensBefore: payload.tokens_before ?? null,
      tokensAfter: payload.tokens_after ?? null,
    };
  }
  const detail = payload.detail ?? payload;
  if (kind === "approval") {
    return {
      kind: "approval",
      seq: ev.seq,
      toolCallId: detail.tool_call_id ?? "",
      tool: detail.tool ?? "",
      decision: detail.decision ?? "",
      resolvedBy: detail.resolved_by ?? "",
    };
  }
  if (kind === "turn-end") {
    return {
      kind: "turn-end",
      seq: ev.seq,
      turn: detail.turn ?? 0,
      reason: detail.reason ?? "",
      error: detail.error ?? null,
      summary: detail.summary ?? null,
    };
  }
  if (kind === "turn-notice") {
    return {
      kind: "turn-notice",
      seq: ev.seq,
      severity: detail.severity ?? "info",
      text: detail.text ?? "",
    };
  }
  if (kind === "tool-result-prune") {
    return {
      kind: "tool-result-prune",
      seq: ev.seq,
      targetSeq: detail.target_seq ?? 0,
      notice: detail.notice ?? "",
    };
  }
  return { kind, seq: ev.seq, raw: detail };
}
