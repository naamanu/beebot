import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTasks } from "../server/tasks.ts";
import type { AgentView, MissionView } from "../server/types.ts";
import { Incident } from "../server/incident/incident.ts";
import { Jamie } from "../server/incident/jamie.ts";

function agent(id: string, missionId: string | null): AgentView {
  return { id, missionId, task: "Generated workstream instructions", status: "idle", events: [{ kind: "result", text: `Result ${id}`, at: 100 }], costUsd: 1, runId: null, template: "coding", role: id === "4" ? "Lead" : "Worker", title: null, startsAt: null, approval: null };
}
function mission(overrides: Partial<MissionView> = {}): MissionView {
  return { id: "task-1", title: "Build taskboard", quick: false, request: "Add due dates, export and CLI", template: "coding", files: [], status: "done", plan: null, revisions: [], allocation: null, workers: ["1", "2", "3"].map((id) => ({ name: `Worker ${id}`, agentId: id, state: "done" })), leadAgentId: "4", costUsd: 0.5, createdAt: 1, endedAt: 100, error: null, ...overrides };
}

test("one task groups every workstream and its lead with a combined cost and result", () => {
  const tasks = buildTasks(["1", "2", "3", "4"].map((id) => agent(id, "task-1")), [mission()], null);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0]!.agentIds, ["1", "2", "3", "4"]);
  assert.equal(tasks[0]!.result, "Result 4");
  assert.equal(tasks[0]!.branch, "agent-4");
  assert.equal(tasks[0]!.costUsd, 4.5);
});

test("membership survives a snapshot that has not listed its new worker yet", () => {
  const tasks = buildTasks([agent("1", "task-1")], [mission({ workers: [], leadAgentId: null, status: "running" })], null);
  assert.deepEqual(tasks[0]!.agentIds, ["1"]);
});

test("legacy and orphan agents never become separate tasks", () => {
  const tasks = buildTasks([agent("legacy", null), agent("orphan", "missing-task")], [mission({ workers: [], leadAgentId: null })], null);
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0]!.agentIds, []);
  assert.deepEqual(buildTasks([agent("legacy", null)], [], null), []);
});

test("cancelled tasks retain their workers under a stopped parent", () => {
  const tasks = buildTasks([agent("1", "task-1")], [mission({ status: "cancelled", workers: [{ name: "Worker", agentId: "1", state: "running" }], leadAgentId: null })], null);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.status, "stopped");
  assert.deepEqual(tasks[0]!.agentIds, ["1"]);
});

test("separate tasks with identical requests stay separate", () => {
  const tasks = buildTasks([agent("1", "task-1"), agent("2", "task-2")], [mission({ workers: [], leadAgentId: null }), mission({ id: "task-2", workers: [], leadAgentId: null })], null);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((task) => task.agentIds), [["1"], ["2"]]);
});

test("incident investigators share the same task ID used by their activity", () => {
  const incident = new Incident("Checkout failure", "SEV1", new Jamie(undefined), () => {});
  const investigators = ["1", "2", "3", "4"].map((id) => ({ ...agent(id, null), template: "incident" as const }));
  const tasks = buildTasks(investigators, [], incident.view());
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.id, incident.id);
  assert.deepEqual(tasks[0]!.agentIds, ["1", "2", "3", "4"]);
});

test("finished workstreams produce a reviewable task with its final result", () => {
  const tasks = buildTasks(["1", "2", "3", "4"].map((id) => agent(id, "task-1")), [mission({ status: "ready", endedAt: null })], null);
  assert.equal(tasks[0]!.status, "ready");
  assert.equal(tasks[0]!.needs[0]!.type, "completion");
  assert.equal(tasks[0]!.result, "Result 4");
});

test("a follow-up or approval keeps completion unavailable while agents are busy", () => {
  for (const state of ["working", "blocked", "paused", "error"] as const) {
    const agents = [agent("1", "task-1"), { ...agent("4", "task-1"), status: state }];
    const task = buildTasks(agents, [mission({ status: "ready", workers: [{ name: "Worker", agentId: "1", state: "done" }] })], null)[0]!;
    assert.notEqual(task.status, "ready");
    assert.equal(task.needs.some((need) => need.type === "completion"), false);
  }
});

test("an incident becomes ready after its investigators finish and done only when resolved", () => {
  const incident = new Incident("Checkout failure", "SEV1", new Jamie(undefined), () => {});
  const investigators = ["1", "2", "3", "4"].map((id) => ({ ...agent(id, null), template: "incident" as const }));
  assert.equal(buildTasks(investigators, [], incident.view())[0]!.status, "ready");
  investigators[0]!.status = "working";
  assert.equal(buildTasks(investigators, [], incident.view())[0]!.status, "working");
  investigators[0]!.status = "idle";
  incident.setStatus("resolved", "commander");
  assert.equal(buildTasks(investigators, [], incident.view())[0]!.status, "done");
});

test("missing workers or a missing required lead cannot be presented as ready", () => {
  const members = [agent("1", "task-1")];
  const base = mission({ status: "ready", workers: [{ name: "Worker", agentId: "1", state: "done" }], leadAgentId: null });
  const missingWorker: MissionView = { ...base, workers: [...base.workers, { name: "Missing", agentId: "2", state: "done" }] };
  const missingLead: MissionView = { ...base, allocation: { reasoning: "Combine outputs", workstreams: [], synthesis: true, leadStepIds: [] } };
  for (const parent of [missingWorker, missingLead]) assert.notEqual(buildTasks(members, [parent], null)[0]!.status, "ready");
});
