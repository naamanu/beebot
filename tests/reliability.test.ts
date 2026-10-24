import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import type { Allocation, Plan } from "../server/types.ts";
import type { SpawnRequest } from "../server/missions/mission.ts";

// Only SDK responses are stubbed. These tests never contact a model provider.
process.env.ANTHROPIC_API_KEY = "test-placeholder";
const { Mission } = await import("../server/missions/mission.ts");
const { Router } = await import("../server/router.ts");
const sdk = new Anthropic({ apiKey: "test-placeholder" });
const plan: Plan = {
  summary: "Prepare data, then write a report.",
  steps: [
    { id: "S1", title: "Prepare", detail: "Prepare the inputs.", dependsOn: [] },
    { id: "S2", title: "Report", detail: "Use the prepared inputs.", dependsOn: ["S1"] },
  ],
  risks: [],
};
const allocation: Allocation = {
  reasoning: "The report consumes the preparation output.",
  workstreams: [
    { name: "Preparation", stepIds: ["S1"], after: [], rationale: "Prepare inputs." },
    { name: "Report", stepIds: ["S2"], after: ["Preparation"], rationale: "Consume inputs." },
  ],
  synthesis: false,
  leadStepIds: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function response(data: unknown) {
  return { parsed_output: data, model: "test", stop_reason: "end_turn", usage: { input_tokens: 0, output_tokens: 0 } };
}

function stubPlanner(t: TestContext, ...responses: unknown[]) {
  t.mock.method(Object.getPrototypeOf(sdk.beta.messages), "parse", async () => {
    assert.ok(responses.length, "Unexpected model call");
    return responses.shift();
  });
}

function mission() {
  const spawned: SpawnRequest[] = [];
  const stopped: string[] = [];
  const hooks = {
    spawn: (_: unknown, request: SpawnRequest) => { spawned.push(request); return String(spawned.length); },
    stop: (id: string) => { stopped.push(id); },
    changed: () => {},
    speak: () => {},
  };
  return {
    mission: new Mission({ template: "general", request: "Prepare a report", files: [], repoFiles: [] }, hooks),
    spawned,
    stopped,
  };
}

test("cancelling planning discards a late successful response", async (t) => {
  const pending = deferred<ReturnType<typeof response>>();
  stubPlanner(t, pending.promise);
  const { mission: m, spawned } = mission();
  const work = m.start();
  m.cancel();
  pending.resolve(response(plan));
  await work;
  assert.equal(m.status, "cancelled");
  assert.equal(spawned.length, 0);
});

test("cancelling allocation never starts a worker", async (t) => {
  const pending = deferred<ReturnType<typeof response>>();
  stubPlanner(t, response(plan), pending.promise);
  const { mission: m, spawned } = mission();
  await m.start();
  const work = m.approve();
  m.cancel();
  pending.resolve(response(allocation));
  await work;
  assert.equal(m.status, "cancelled");
  assert.equal(spawned.length, 0);
});

test("a late request failure cannot overwrite cancellation", async (t) => {
  const pending = deferred<ReturnType<typeof response>>();
  stubPlanner(t, pending.promise);
  const { mission: m } = mission();
  const work = m.start();
  m.cancel();
  pending.reject(new Error("Request interrupted"));
  await work;
  assert.equal(m.status, "cancelled");
  assert.equal(m.error, null);
});

test("a failed prerequisite does not release its dependent worker", async (t) => {
  stubPlanner(t, response(plan), response(allocation));
  const { mission: m, spawned } = mission();
  await m.start();
  await m.approve();
  assert.equal(spawned.length, 1);
  m.onAgentFinished("1", false);
  assert.equal(spawned.length, 1);
  assert.equal(m.status, "failed");
  assert.match(m.error ?? "", /Preparation/);
});

test("cancelling a running mission stops its workers and ignores late results", async (t) => {
  stubPlanner(t, response(plan), response(allocation));
  const { mission: m, spawned, stopped } = mission();
  await m.start();
  await m.approve();
  m.cancel();
  m.onAgentFinished("1", true);
  assert.deepEqual(stopped, ["1"]);
  assert.equal(spawned.length, 1);
  assert.equal(m.status, "cancelled");
});

test("cyclic workstreams fail before any agent starts", async (t) => {
  const cyclic = structuredClone(allocation);
  cyclic.workstreams[0]!.after = ["Report"];
  stubPlanner(t, response(plan), response(cyclic));
  const { mission: m, spawned } = mission();
  await m.start();
  await m.approve();
  assert.equal(m.status, "failed");
  assert.equal(spawned.length, 0);
  assert.match(m.error ?? "", /cycl/i);
});

test("plan dependencies are enforced even when allocation omits after", async (t) => {
  const missingDependency = structuredClone(allocation);
  missingDependency.workstreams[1]!.after = [];
  stubPlanner(t, response(plan), response(missingDependency));
  const { mission: m, spawned } = mission();
  await m.start();
  await m.approve();
  assert.equal(spawned.length, 1);
  m.onAgentFinished("1", true);
  assert.equal(spawned.length, 2);
});

test("duplicate workstream names are rejected", async (t) => {
  const duplicate = structuredClone(allocation);
  duplicate.workstreams[1]!.name = "Preparation";
  duplicate.workstreams[1]!.after = [];
  stubPlanner(t, response(plan), response(duplicate));
  const { mission: m, spawned } = mission();
  await m.start();
  await m.approve();
  assert.equal(m.status, "failed");
  assert.equal(spawned.length, 0);
});

function stubVotes(t: TestContext, actions: (string | Error)[]) {
  t.mock.method(Object.getPrototypeOf(sdk.messages), "parse", async () => {
    const action = actions.shift();
    if (action instanceof Error) throw action;
    return response({ target: action === "assign" ? "new" : "all", intent: action === "assign" ? "assign" : "incident", instruction: "Fixture task", incident_action: action === "assign" ? "none" : action });
  });
}

const routerContext = { agents: [], rules: [], recent: [], pendingClarification: null };

test("one surviving router vote out of five cannot execute work", async (t) => {
  stubVotes(t, [new Error("unavailable"), new Error("unavailable"), new Error("unavailable"), new Error("unavailable"), "assign"]);
  const verdict = await new Router("test", 5).route("Start work", routerContext);
  assert.equal(verdict.action, "clarify");
  assert.equal(verdict.confidence, 0.2);
});

test("incident actions are included in vote agreement", async (t) => {
  stubVotes(t, ["declare", "declare", "resolved", "resolved", "mitigated"]);
  const verdict = await new Router("test", 5).route("Update the incident", routerContext);
  assert.equal(verdict.action, "clarify");
  assert.equal(verdict.confidence, 0.4);
});

test("three matching successful votes still form a quorum", async (t) => {
  stubVotes(t, ["assign", "assign", "assign", new Error("unavailable"), new Error("unavailable")]);
  const verdict = await new Router("test", 5).route("Start work", routerContext);
  assert.equal(verdict.action, "applied");
  assert.equal(verdict.confidence, 0.6);
});

test("each workstream finishes independently and the lead must finish before task review", async (t) => {
  const parallelPlan = structuredClone(plan);
  parallelPlan.steps[1]!.dependsOn = [];
  const parallel = structuredClone(allocation);
  parallel.workstreams[1]!.after = [];
  parallel.synthesis = true;
  stubPlanner(t, response(parallelPlan), response(parallel));
  const { mission: m, spawned } = mission();
  await m.start();
  await m.approve();
  assert.equal(spawned.length, 2);
  assert.equal(m.complete(), false);
  m.onAgentFinished("1", true);
  assert.deepEqual(m.view().workers.map((worker) => worker.state), ["done", "running"]);
  assert.equal(m.status, "running");
  m.onAgentFinished("2", true);
  assert.equal(m.status, "synthesizing");
  assert.equal(spawned.length, 3);
  assert.equal(m.complete(), false);
  m.onAgentFinished("3", true);
  assert.equal(m.status, "ready");
  assert.equal(m.endedAt, null);
  assert.equal(m.complete(), true);
  assert.equal(m.status, "done");
  assert.ok(m.endedAt);
  m.onAgentFinished("2", true);
  assert.equal(spawned.length, 3);
});

test("quick work becomes ready and only operator completion marks it done", () => {
  const { mission: m } = mission();
  m.startQuick();
  assert.equal(m.complete(), false);
  m.onAgentFinished("1", true);
  assert.equal(m.view().workers[0]!.state, "done");
  assert.equal(m.status, "ready");
  assert.equal(m.complete(), true);
  assert.equal(m.status, "done");
});

test("failed or cancelled work cannot be marked complete", () => {
  for (const success of [false, true]) {
    const { mission: m } = mission();
    m.startQuick();
    if (success) m.cancel();
    else m.onAgentFinished("1", false);
    assert.equal(m.complete(), false);
    assert.notEqual(m.status, "done");
  }
});
