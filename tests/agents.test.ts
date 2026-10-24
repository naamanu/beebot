import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Agent, type AgentOptions } from "../server/agents.ts";
import { Telemetry } from "../server/telemetry.ts";
import { Incident } from "../server/incident/incident.ts";
import { Jamie } from "../server/incident/jamie.ts";

class FakeQuery implements AsyncIterable<SDKMessage> {
  private items: SDKMessage[] = [];
  private waiting: ((result: IteratorResult<SDKMessage>) => void) | null = null;
  private ended = false;
  inputs: SDKUserMessage[] = [];
  interrupt = async () => {};
  push(message: SDKMessage): void {
    if (this.waiting) { const next = this.waiting; this.waiting = null; next({ value: message, done: false }); }
    else this.items.push(message);
  }
  close(): void { this.ended = true; this.waiting?.({ value: undefined, done: true }); this.waiting = null; }
  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return { next: () => {
      const item = this.items.shift();
      if (item) return Promise.resolve({ value: item, done: false });
      if (this.ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => { this.waiting = resolve; });
    } };
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const idle: SDKMessage = { type: "system", subtype: "session_state_changed", state: "idle", uuid: randomUUID(), session_id: "session" };

function setup(t: TestContext, overrides: Partial<AgentOptions> = {}) {
  const query = new FakeQuery();
  const finished: boolean[] = [];
  const telemetry = new Telemetry(":memory:");
  let calls = 0;
  let queryOptions: Options | undefined;
  const options: AgentOptions = {
    id: "1", task: "Fixture task", cwd: process.cwd(), workspace: "fixture", model: "test", rules: () => "",
    telemetry, onEvent: () => {}, onFinished: (_, ok) => { finished.push(ok); },
    runQuery: ({ prompt, options }) => {
      calls++;
      queryOptions = options;
      assert.notEqual(typeof prompt, "string");
      void (async () => { for await (const message of prompt as AsyncIterable<SDKUserMessage>) query.inputs.push(message); })();
      return query as unknown as Query;
    },
    ...overrides,
  };
  const agent = new Agent(options);
  t.after(() => { agent.close("reset"); telemetry.close(); });
  return { agent, query, finished, telemetry, calls: () => calls, options: () => queryOptions };
}

test("every worker enables the idle events required to report completion", (t) => {
  const incident = new Incident("Checkout failure", "SEV1", new Jamie(undefined), () => {});
  for (const overrides of [{}, { template: "general" as const }, { incident: { incident, role: "Logs" } }]) {
    const { agent, options } = setup(t, overrides);
    agent.begin();
    assert.equal(options()?.env?.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, "1");
    assert.equal(options()?.env?.PATH, process.env.PATH);
  }
});

test("incident runs belong to their incident task", (t) => {
  const incident = new Incident("Checkout failure", "SEV1", new Jamie(undefined), () => {});
  const { agent, telemetry } = setup(t, { incident: { incident, role: "Logs" } });
  agent.begin();
  assert.equal(telemetry.listRuns({})[0]!.taskId, incident.id);
});

function result(uuid: string, is_error = false): SDKMessage {
  return {
    type: "result", subtype: "success", is_error, user_message_uuid: uuid, user_message_uuids: [uuid], queued_turn_count: 0,
    result: is_error ? "Provider error" : "Done", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    duration_ms: 1, duration_api_ms: 1, num_turns: 1, uuid: "result", session_id: "session", modelUsage: {}, permission_denials: [], stop_reason: "end_turn",
  } as unknown as SDKMessage;
}

test("a worker completes only after its result and SDK idle", async (t) => {
  const { agent, query, finished } = setup(t);
  agent.begin();
  await settle();
  query.push(result(query.inputs[0]!.uuid!));
  await settle();
  assert.deepEqual(finished, []);
  assert.equal(agent.status, "working");
  query.push(idle);
  await settle();
  assert.deepEqual(finished, [true]);
  assert.equal(agent.status, "idle");
});

test("a correction queued behind a result prevents premature completion", async (t) => {
  const { agent, query, finished } = setup(t);
  agent.begin();
  await settle();
  agent.correct("Also handle time zones");
  await settle();
  query.push(result(query.inputs[0]!.uuid!));
  query.push(idle);
  await settle();
  assert.deepEqual(finished, []);
  assert.equal(agent.status, "working");
  query.push(result(query.inputs[1]!.uuid!));
  query.push(idle);
  query.push(idle);
  await settle();
  assert.deepEqual(finished, [true]);
});

test("an SDK success frame carrying is_error fails the worker and its trace", async (t) => {
  const { agent, query, finished, telemetry } = setup(t);
  agent.begin();
  const runId = agent.runId!;
  await settle();
  query.push(result(query.inputs[0]!.uuid!, true));
  query.push(idle);
  await settle();
  assert.deepEqual(finished, [false]);
  assert.equal(agent.status, "error");
  assert.equal(telemetry.getRun(runId)?.run.status, "error");
  assert.equal(agent.events.some((event) => event.kind === "result"), false);
});

test("stopping during undo cancels the timer without starting a query", async (t) => {
  const { agent, calls } = setup(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  agent.beginAfter(4000, () => {});
  await agent.stop("Stopped before start");
  t.mock.timers.tick(5000);
  assert.equal(calls(), 0);
  assert.equal(agent.status, "paused");
});

test("a successful result after stop cannot complete the paused mission", async (t) => {
  const { agent, query, finished } = setup(t);
  agent.begin();
  await settle();
  await agent.stop("Paused");
  query.push(result(query.inputs[0]!.uuid!));
  query.push(idle);
  await settle();
  assert.deepEqual(finished, []);
  assert.equal(agent.status, "paused");
});

test("closed agents reject new work instead of silently queuing it", (t) => {
  const { agent, calls } = setup(t);
  agent.close("reset");
  assert.throws(() => agent.correct("Continue"), /closed/);
  assert.equal(calls(), 0);
});

test("a standing rule queued on a finished worker immediately makes it busy again", async (t) => {
  const { agent, query } = setup(t);
  agent.begin();
  await settle();
  query.push(result(query.inputs[0]!.uuid!));
  query.push(idle);
  await settle();
  assert.equal(agent.status, "idle");
  agent.addRule("Keep all existing tests passing");
  assert.equal(agent.status, "working");
  assert.equal(agent.snapshot().pendingMessages, 1);
});
