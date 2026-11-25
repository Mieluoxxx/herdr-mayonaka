import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isLoopbackHost,
  parseTcpAddr,
  scanRunDir,
  pickTargetProcess,
  NdjsonDecoder,
  MizarRpcClient,
  createSessionState,
  applySnapshot,
  prependPagedEvents,
  applyNotification,
  summarizeCommittedEvent,
} from "./rpc.js";
import { parsePill, toneOfKey, splitMarkdownWithPills } from "./emphasis.js";
import { parseUnifiedDiff } from "./diff.js";
import {
  posixQuote,
  buildLaunchCommand,
  waitForReadyFile,
  parseComposerCommand,
  detectActiveCompletion,
  filterFileCandidates,
} from "./launcher.js";

function nodeConnectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const chunks = [];
    let ended = false;
    let errState = null;
    let waiter = null;

    const wake = () => {
      if (!waiter) return;
      const w = waiter;
      if (chunks.length > 0) {
        waiter = null;
        w.resolve(chunks.shift());
      } else if (errState) {
        waiter = null;
        w.reject(errState);
      } else if (ended) {
        waiter = null;
        w.resolve(null);
      }
    };

    sock.on("data", (buf) => {
      chunks.push(buf);
      wake();
    });
    sock.on("end", () => {
      ended = true;
      wake();
    });
    sock.on("close", () => {
      ended = true;
      wake();
    });
    sock.on("error", (err) => {
      errState = err;
      ended = true;
      wake();
    });

    sock.once("connect", () => {
      resolve({
        read(_maxBytes) {
          if (chunks.length > 0) return Promise.resolve(chunks.shift());
          if (errState) return Promise.reject(errState);
          if (ended) return Promise.resolve(null);
          return new Promise((res, rej) => {
            waiter = { resolve: res, reject: rej };
          });
        },
        write(data) {
          return new Promise((res, rej) => {
            sock.write(data, (err) => (err ? rej(err) : res()));
          });
        },
        close() {
          try {
            sock.destroy();
          } catch {}
        },
      });
    });

    sock.once("error", reject);
  });
}

test("parseTcpAddr accepts loopback hosts and rejects LAN/invalid ports", () => {
  assert.deepEqual(parseTcpAddr("127.0.0.1:49201"), { host: "127.0.0.1", port: 49201 });
  assert.deepEqual(parseTcpAddr("localhost:8787"), { host: "localhost", port: 8787 });
  assert.deepEqual(parseTcpAddr("[::1]:65535"), { host: "::1", port: 65535 });
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);

  for (const bad of [
    "0.0.0.0:8787",
    "192.168.1.20:8787",
    "10.0.0.5:8787",
    "[fe80::1]:8787",
    "example.com:8787",
    "127.0.0.1:0",
    "127.0.0.1:70000",
    "127.0.0.1",
    "",
    null,
  ]) {
    assert.equal(parseTcpAddr(bad), null, `expected reject for ${String(bad)}`);
  }
});

test("scanRunDir and pickTargetProcess respect validity and priority", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mayonaka-mizar-run-"));
  try {
    await fs.writeFile(
      path.join(tmpDir, "p-101.json"),
      JSON.stringify({
        pid: 101,
        session_id: "s-old",
        cwd: "/Users/me/repo-a",
        tcp_addr: "127.0.0.1:41001",
        rpc_token: "tok-101",
        started_at_ms: 1000,
      }),
    );
    await fs.writeFile(
      path.join(tmpDir, "p-102.json"),
      JSON.stringify({
        pid: 102,
        session_id: "s-pane",
        cwd: "/Users/me/repo-b",
        herdr_pane_id: "pane-xyz",
        tcp_addr: "127.0.0.1:41002",
        rpc_token: "tok-102",
        started_at_ms: 2000,
      }),
    );
    await fs.writeFile(
      path.join(tmpDir, "p-103.json"),
      JSON.stringify({
        pid: 103,
        session_id: "s-new",
        cwd: "/Users/me/repo-a/sub",
        tcp_addr: "127.0.0.1:41003",
        rpc_token: "tok-103",
        started_at_ms: 3000,
      }),
    );
    await fs.writeFile(
      path.join(tmpDir, "p-999.json"),
      JSON.stringify({
        pid: 999,
        session_id: "s-lan",
        cwd: "/Users/me/repo-a",
        tcp_addr: "192.168.1.99:41999",
        rpc_token: "tok-lan",
        started_at_ms: 9999,
      }),
    );
    await fs.writeFile(
      path.join(tmpDir, "p-998.json"),
      JSON.stringify({
        pid: 998,
        session_id: "s-notok",
        cwd: "/Users/me/repo-a",
        tcp_addr: "127.0.0.1:41998",
      }),
    );
    await fs.writeFile(path.join(tmpDir, "note.txt"), "ignore");

    const procs = await scanRunDir(tmpDir, {
      readdir: (d) => fs.readdir(d),
      readFile: (p, enc) => fs.readFile(p, enc),
    });
    assert.deepEqual(
      procs.map((p) => p.pid),
      [103, 102, 101],
    );

    assert.equal(pickTargetProcess(procs, { preferPid: 101 })?.pid, 101);
    assert.equal(
      pickTargetProcess(procs, { focusedPaneId: "pane-xyz", focusedCwd: "/Users/me/repo-a" })?.pid,
      102,
    );
    assert.equal(pickTargetProcess(procs, { focusedCwd: "/Users/me/repo-a" })?.pid, 101);
    assert.equal(pickTargetProcess(procs, { activeTabCwd: "/Users/me/repo-a/sub/deep" })?.pid, 103);
    assert.equal(pickTargetProcess(procs, {})?.pid, 103);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("NdjsonDecoder handles multi-byte UTF-8 split across chunks", () => {
  const decoder = new NdjsonDecoder();
  const payload = JSON.stringify({ msg: "猫娘浮浮酱 ฅ'ω'ฅ 🚀", seq: 42 }) + "\n" + JSON.stringify({ ok: true }) + "\r\n";
  const raw = Buffer.from(payload, "utf8");
  const part1 = raw.subarray(0, 10);
  const part2 = raw.subarray(10, 28);
  const part3 = raw.subarray(28);

  const lines = [
    ...decoder.push(part1),
    ...decoder.push(part2),
    ...decoder.push(part3),
  ];
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { msg: "猫娘浮浮酱 ฅ'ω'ฅ 🚀", seq: 42 });
  assert.deepEqual(JSON.parse(lines[1]), { ok: true });
});

test("emphasis.js parses pi-emphasis pills, synonyms, tones, and code-block isolation", () => {
  assert.equal(toneOfKey("Costs money"), "danger");
  const completed = parsePill("Completed");
  assert.equal(completed.word, "Done");
  assert.equal(completed.tone, "success");

  const detailed = parsePill("Failed: 2 checks");
  assert.equal(detailed.word, "Failed: 2 checks");
  assert.equal(detailed.tone, "error");

  const md = [
    "[[Implement]] Updating parser",
    "",
    "```js",
    "const literal = '[[NotAPill]]';",
    "```",
    "",
    "Inline code `[[AlsoLiteral]]` stays text, while [[Done]] renders.",
  ].join("\n");

  const blocks = splitMarkdownWithPills(md);
  assert.equal(blocks[0].type, "pill-line");
  assert.equal(blocks[0].segments[0].tone, "mode");
  assert.equal(blocks[1].type, "markdown");
  assert.ok(blocks[1].text.includes("const literal = '[[NotAPill]]';"));
  assert.equal(blocks[2].type, "pill-line");
  assert.equal(blocks[2].segments[0].type, "text");
  assert.ok(blocks[2].segments[0].text.includes("`[[AlsoLiteral]]`"));
  assert.equal(blocks[2].segments[1].type, "pill");
  assert.equal(blocks[2].segments[1].tone, "success");
});

test("diff.js parses unified diffs with line numbers and truncation guard", () => {
  const sample = [
    "--- a/src/main.rs",
    "+++ b/src/main.rs",
    "@@ -10,3 +10,4 @@ fn main() {",
    " line10",
    "-line11_old",
    "+line11_new",
    "+line12_added",
    " line12",
  ].join("\n");

  const res = parseUnifiedDiff(sample, 100);
  assert.equal(res.truncated, 0);
  assert.equal(res.lines[2].kind, "hunk");
  assert.equal(res.lines[3].oldLine, 10);
  assert.equal(res.lines[4].kind, "del");
  assert.equal(res.lines[4].oldLine, 11);
  assert.equal(res.lines[5].kind, "add");
  assert.equal(res.lines[5].newLine, 11);
  assert.equal(res.lines[6].newLine, 12);

  const capped = parseUnifiedDiff(sample, 4);
  assert.equal(capped.lines.length, 4);
  assert.equal(capped.truncated, 4);
});

test("launcher.js builds safe commands, waits for ready-file, and parses / @ ! !! inputs", async () => {
  assert.equal(posixQuote("it's/a path"), "'it'\\''s/a path'");
  const cmd = buildLaunchCommand({
    bin: "/Users/moguw/.local/bin/mizar",
    workspace: "/tmp/my'repo",
    readyFile: "/tmp/ready.json",
    resumeSessionId: "sess-1",
    parentPid: 1234,
    idleExitSecs: 45,
    approve: true,
  });
  assert.ok(cmd.includes("'/Users/moguw/.local/bin/mizar' rpc"));
  assert.ok(cmd.includes("--workspace '/tmp/my'\\''repo'"));
  assert.ok(cmd.includes("--resume 'sess-1'"));
  assert.ok(cmd.includes("--approve"));
  assert.ok(cmd.includes("--parent-pid 1234"));
  assert.ok(cmd.includes("--idle-exit-secs 45"));

  assert.deepEqual(parseComposerCommand("!!git status"), { kind: "bash", command: "git status", excludeFromContext: true });
  assert.deepEqual(parseComposerCommand("!cargo test"), { kind: "bash", command: "cargo test", excludeFromContext: false });
  assert.deepEqual(parseComposerCommand("/model openai/gpt-5"), { kind: "slash", command: "model", arg: "openai/gpt-5" });
  assert.equal(parseComposerCommand("Explain @src/main.rs").kind, "prompt");

  assert.deepEqual(detectActiveCompletion("/mo"), { kind: "slash", query: "mo", replaceStart: 0, replaceEnd: 3 });
  assert.deepEqual(detectActiveCompletion("Check @rpc"), { kind: "mention", query: "rpc", replaceStart: 6, replaceEnd: 10 });
  assert.equal(detectActiveCompletion("hello world"), null);

  assert.deepEqual(filterFileCandidates(["src/rpc.rs", "mods/rpc.js", "README.md"], "rpcjs", 5), ["mods/rpc.js"]);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mayonaka-mizar-ready-"));
  const readyPath = path.join(tmpDir, "ready.json");
  try {
    setTimeout(async () => {
      await fs.writeFile(
        readyPath,
        JSON.stringify({ pid: 4444, session_id: "s-ready", tcp_addr: "127.0.0.1:45555", rpc_token: "tok-ready" }),
      );
    }, 60);
    const meta = await waitForReadyFile(readyPath, {
      readFile: (p, enc) => fs.readFile(p, enc),
      unlink: (p) => fs.unlink(p),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      timeoutMs: 2000,
    });
    assert.equal(meta.pid, 4444);
    assert.equal(meta.tcpPort, 45555);
    await assert.rejects(() => fs.stat(readyPath));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("State reducer applies snapshots, paged events, and all 8 notifications", () => {
  let st = applySnapshot(createSessionState(), {
    session: { id: "s1", cwd: "/tmp/repo", title: "Demo", parent_id: null, fork_seq: null },
    state: "idle",
    config: { provider: "anthropic", model: "claude-sonnet", reasoning_effort: "medium", approval_mode: "high_risk" },
    context: { used_tokens: 1200, max_tokens: 200000 },
    events: [
      { seq: 5, ts_ms: 500, visibility: "surface", kind: "user", payload: { type: "user", text: "hi" } },
    ],
    active_turn: null,
    pending_interactions: [],
    queued_inputs: [],
    subagents: [],
  });
  assert.equal(st.hasMoreHistory, true);
  assert.equal(st.events.length, 1);

  st = prependPagedEvents(
    st,
    [{ seq: 1, ts_ms: 100, visibility: "surface", kind: "user", payload: { type: "user", text: "first" } }],
    false,
  );
  assert.equal(st.hasMoreHistory, false);
  assert.deepEqual(st.events.map((e) => e.seq), [1, 5]);

  st = applyNotification(st, "turn.state", { session_id: "s1", turn: 2, step: 1, state: "streaming" });
  st = applyNotification(st, "stream.delta", { session_id: "s1", turn: 2, step: 1, kind: "reasoning", delta: "think " });
  st = applyNotification(st, "stream.delta", { session_id: "s1", turn: 2, step: 1, kind: "text", delta: "hello" });
  st = applyNotification(st, "stream.delta", { session_id: "s1", turn: 2, step: 1, kind: "tool_args", call_id: "c1", delta: "{\"cmd\":" });
  st = applyNotification(st, "stream.delta", { session_id: "s1", turn: 2, step: 1, kind: "tool_output", call_id: "c1", delta: "running\n" });

  st = applyNotification(st, "interaction.requested", {
    session_id: "s1",
    request_id: "req_1",
    kind: "approval",
    call_id: "c1",
    tool: "bash",
    summary: "Run rm",
    args: { command: "rm x" },
    options: ["allow_once", "deny"],
  });
  assert.equal(st.state, "waiting_approval");

  st = applyNotification(st, "interaction.resolved", { session_id: "s1", request_id: "req_1", decision: "allow_once" });
  assert.equal(st.state, "streaming");

  st = applyNotification(st, "event.committed", {
    session_id: "s1",
    seq: 6,
    ts_ms: 600,
    visibility: "surface",
    kind: "assistant",
    payload: { type: "assistant", blocks: [{ type: "text", text: "hello" }], usage: { input_tokens: 500, output_tokens: 100 } },
  });
  assert.equal(st.context.used_tokens, 600);
  assert.equal(st.activeTurn.text, "");

  st = applyNotification(st, "event.committed", {
    session_id: "s1",
    seq: 7,
    ts_ms: 700,
    visibility: "surface",
    kind: "tool-result",
    payload: {
      type: "tool-result",
      tool_call_id: "c1",
      name: "edit",
      content: "edited",
      is_error: false,
      meta: { kind: "diff", path: "src/main.rs", added: 3, removed: 1, diff: "+a\n-b" },
    },
  });
  assert.equal(st.activeTurn.running_tools.length, 0);

  st = applyNotification(st, "event.committed", {
    session_id: "s1",
    seq: 8,
    ts_ms: 800,
    visibility: "log_only",
    kind: "turn-end",
    payload: { detail: { kind: "turn-end", turn: 2, reason: "stop", summary: { durationMs: 420, filesChanged: ["src/main.rs"], commandsRun: 1, toolErrors: 0 } } },
  });
  assert.equal(st.activeTurn, null);

  st = applyNotification(st, "queue.updated", { session_id: "s1", items: [{ id: 9, text: "next", created_at_ms: 900 }] });
  st = applyNotification(st, "subagent.updated", {
    session_id: "s1",
    task: { name: "explorer", child_session_id: "sub-1", mode: "read_only", status: "running", current_step: 2, steps: 5 },
    notice: "explorer step 2",
  });
  st = applyNotification(st, "session.switched", { old_session_id: "s1", new_session_id: "s2" });
  assert.equal(st.switchedTo, "s2");

  const turnSummary = summarizeCommittedEvent(st.events.find((e) => e.seq === 8));
  assert.equal(turnSummary.summary.durationMs, 420);
});

test("MizarRpcClient loopback TCP handshake, auth.hello, old + new methods, and notifications", async () => {
  const EXPECTED_TOKEN = "secret-token-0123456789";
  const recorded = [];

  const server = net.createServer((socket) => {
    let authed = false;
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) break;
        const line = buf.subarray(0, nl).toString("utf8").trim();
        buf = buf.subarray(nl + 1);
        if (!line) continue;
        const req = JSON.parse(line);
        recorded.push(req);

        if (!authed) {
          if (req.method !== "auth.hello" || req.params?.token !== EXPECTED_TOKEN) {
            socket.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32003, message: "unauthorized" } }) + "\n");
            socket.end();
            return;
          }
          authed = true;
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\n");
          continue;
        }

        if (req.method === "session.subscribe") {
          socket.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              session: { id: req.params.session_id, cwd: "/tmp/ws", title: "Live", parent_id: null, fork_seq: null },
              state: "idle",
              config: { provider: "anthropic", model: "claude-sonnet", reasoning_effort: "high", approval_mode: "auto" },
              context: { used_tokens: 200, max_tokens: 200000 },
              events: [],
              active_turn: null,
              pending_interactions: [],
              queued_inputs: [],
              subagents: [],
            },
          }) + "\n");
        } else if (req.method === "turn.submit") {
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { accepted: true, queued: false } }) + "\n");
          socket.write(JSON.stringify({
            jsonrpc: "2.0",
            method: "stream.delta",
            params: { session_id: req.params.session_id, turn: 1, step: 1, kind: "text", delta: "pong!" },
          }) + "\n");
        } else if (req.method === "interaction.resolve") {
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { ok: true } }) + "\n");
        } else if (req.method === "session.tree") {
          socket.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              session_id: req.params.session_id,
              entries: [
                { seq: 1, kind_tag: "user", summary: "hi", depth: 0, can_fork: true },
                { seq: 2, kind_tag: "assistant", summary: "hello", depth: 1, can_fork: true },
              ],
            },
          }) + "\n");
        } else if (req.method === "bash.run") {
          socket.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: {
              call_id: "local-bash-1",
              command: req.params.command,
              output: "BASH_OUT",
              exit_code: 0,
              cancelled: false,
              exclude_from_context: Boolean(req.params.exclude_from_context),
            },
          }) + "\n");
        } else if (req.method === "session.compact") {
          socket.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { compacted: true, message: "Compacted" },
          }) + "\n");
        } else if (req.method === "session.new") {
          socket.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { session: { id: "s-fresh", cwd: "/tmp/ws", title: req.params.title ?? null, parent_id: null, fork_seq: null } },
          }) + "\n");
        } else if (req.method === "session.switch") {
          socket.write(JSON.stringify({
            jsonrpc: "2.0",
            id: req.id,
            result: { session: { id: req.params.session_id, cwd: "/tmp/ws", title: "Live", parent_id: null, fork_seq: null } },
          }) + "\n");
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const tcpAddr = `127.0.0.1:${addr.port}`;

  try {
    const badClient = new MizarRpcClient({ connectTcp: nodeConnectTcp });
    await assert.rejects(
      () => badClient.connect({ pid: 1, session_id: "s-live", tcp_addr: tcpAddr, rpc_token: "wrong" }),
      (err) => err.code === -32003,
    );
    badClient.close();

    const client = new MizarRpcClient({ connectTcp: nodeConnectTcp });
    const pushed = [];
    client.onNotification((method, params) => pushed.push({ method, params }));

    await client.connect({ pid: 2, session_id: "s-live", tcp_addr: tcpAddr, rpc_token: EXPECTED_TOKEN });
    const snap = await client.sessionSubscribe("s-live");
    assert.equal(snap.session.title, "Live");

    let state = applySnapshot(createSessionState(), snap);
    assert.equal((await client.turnSubmit("s-live", "ping", "send")).accepted, true);
    assert.equal((await client.interactionResolve("req_99", "allow_once")).ok, true);
    assert.equal((await client.sessionTree("s-live")).entries[1].kind_tag, "assistant");

    const bashRes = await client.bashRun("s-live", "pwd", true);
    assert.equal(bashRes.exit_code, 0);
    assert.equal(bashRes.exclude_from_context, true);

    assert.equal((await client.sessionCompact("s-live")).compacted, true);
    assert.equal((await client.sessionNew("Fresh")).session.id, "s-fresh");
    assert.equal((await client.sessionSwitch("s-live")).session.id, "s-live");

    for (let i = 0; i < 20 && pushed.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(pushed.length, 1);
    state = applyNotification(state, pushed[0].method, pushed[0].params);
    assert.equal(state.activeTurn?.text, "pong!");

    assert.equal(recorded[0].method, "auth.hello");
    client.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
