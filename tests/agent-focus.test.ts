import assert from "node:assert/strict";
import { setImmediate as settle } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { AgentView, ClientMsg, MissionView, RouteVerdict, ServerMsg } from "../server/types.ts";
import { connectTower, useTower } from "../web/lib/store.ts";

const agent: AgentView = { id: "7", missionId: "task-7", task: "Build due dates", status: "idle", events: [], costUsd: 0, runId: null, template: "coding", role: "Due dates", title: "Build due dates", startsAt: null, approval: null };
const mission: MissionView = { id: "task-7", title: "Due dates", quick: true, request: "Build due dates", template: "coding", files: [], status: "done", plan: null, revisions: [], allocation: null, workers: [{ name: "Due dates", agentId: "7", state: "done" }], leadAgentId: null, costUsd: 0, createdAt: 1, endedAt: 2, error: null };
const verdict: RouteVerdict = { utterance: "Agent seven, stop", target: "7", intent: "stop", instruction: "Stop", incidentAction: "none", confidence: 1, votes: [{ target: "7", intent: "stop", count: 5 }], action: "applied", ms: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } };

class BrowserSocket {
  static OPEN = 1;
  static latest: BrowserSocket;
  readyState = 1;
  onopen?: () => void;
  onclose?: () => void;
  onmessage?: (event: { data: string }) => void;
  sent: ClientMsg[] = [];
  constructor(_url: string) { BrowserSocket.latest = this; }
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; this.onclose?.(); }
  receive(message: ServerMsg) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

async function browser(t: TestContext) {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const location = { protocol: "http:", host: "localhost:5173", hash: "#/runs" };
  for (const [key, value] of Object.entries({ WebSocket: BrowserSocket, location, fetch: async () => ({ ok: true }) })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  useTower.setState({ ...useTower.getInitialState(), agents: [agent], missions: [mission] }, true);
  const disconnect = connectTower();
  await settle();
  const socket = BrowserSocket.latest;
  socket.onopen?.();
  socket.sent = [];
  t.after(() => {
    disconnect();
    useTower.setState(useTower.getInitialState(), true);
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  return { socket, location };
}

function command(text = verdict.utterance) {
  useTower.getState().send({ type: "say", text });
}

test("a confirmed typed agent command opens its inspector and owning task", async (t) => {
  const { socket, location } = await browser(t);
  command();
  socket.receive({ type: "verdict", verdict });
  assert.equal(useTower.getState().focused, "7");
  assert.equal(useTower.getState().selectedTaskId, "task-7");
  assert.equal(location.hash, "/");
  assert.ok(socket.sent.some((message) => message.type === "focus" && message.id === "7"));
  assert.ok(socket.sent.some((message) => message.type === "command_context" && message.context.taskId === "task-7"));
});

test("a final voice transcript opens the routed agent without parsing number words", async (t) => {
  const { socket } = await browser(t);
  socket.receive({ type: "transcript", text: verdict.utterance, final: true });
  assert.equal(useTower.getState().focused, null);
  socket.receive({ type: "verdict", verdict });
  assert.equal(useTower.getState().focused, "7");
});

test("interim speech and another tab's verdict cannot open an inspector", async (t) => {
  const { socket, location } = await browser(t);
  socket.receive({ type: "transcript", text: verdict.utterance, final: false });
  socket.receive({ type: "verdict", verdict });
  assert.equal(useTower.getState().focused, null);
  assert.equal(location.hash, "#/runs");
});

test("ambiguous, ignored, global and unknown targets leave the current view alone", async (t) => {
  const { socket, location } = await browser(t);
  for (const patch of [{ action: "clarify" }, { action: "ignored" }, { target: "all" }, { target: "new" }, { target: "plan" }, { target: "999" }, { intent: "rule" }, { intent: "incident" }] as Partial<RouteVerdict>[]) {
    command();
    socket.receive({ type: "verdict", verdict: { ...verdict, ...patch } });
    assert.equal(useTower.getState().focused, null);
    assert.equal(useTower.getState().selectedTaskId, null);
    assert.equal(location.hash, "#/runs");
  }
});

test("opening another agent selects its task and clears an old output selection", async (t) => {
  const { socket } = await browser(t);
  useTower.setState({ selectedTaskId: "other-task", focused: "other-agent", focusedOutput: "report.md" });
  command();
  socket.receive({ type: "verdict", verdict });
  assert.equal(useTower.getState().focused, "7");
  assert.equal(useTower.getState().selectedTaskId, "task-7");
  assert.equal(useTower.getState().focusedOutput, null);
  useTower.getState().setFocus(null);
  assert.equal(useTower.getState().selectedTaskId, "task-7");
});

test("restored decisions never reopen an agent and a verdict is handled only once", async (t) => {
  const { socket } = await browser(t);
  socket.receive({ type: "state", watch: { enabled: true, errorRate: 0.4, state: "healthy", thresholdPct: 5, lastCheckAt: 0, series: [] }, proposals: [], agents: [agent], missions: [mission], incident: null, rules: [], decisions: [{ verdict }], tasks: [] });
  assert.equal(useTower.getState().focused, null);
  command();
  socket.receive({ type: "verdict", verdict });
  useTower.getState().setFocus(null);
  socket.receive({ type: "verdict", verdict });
  assert.equal(useTower.getState().focused, null);
});
