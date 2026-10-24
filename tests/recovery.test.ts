import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSnapshot } from "../server/agents.ts";
import type { AgentView, MissionView } from "../server/types.ts";
import { recoverAgent, recoverMission } from "../server/missions/recovery.ts";

const snapshot: AgentSnapshot = { id: "1", task: "Write the report", cwd: "/fixture", status: "working", events: [{ at: 1, kind: "result", text: "Report finished" }], costUsd: 0, sessionId: "session", runId: null, mission: { id: "task", role: "Writer" } };
const view: AgentView = { id: "1", task: snapshot.task, status: "idle", events: snapshot.events, costUsd: 0, runId: null, template: "general", missionId: "task", role: "Writer", title: null, startsAt: null, approval: null };
const mission: MissionView = { id: "task", title: "Write the report", request: snapshot.task, quick: true, template: "general", files: [], status: "running", plan: null, revisions: [], allocation: null, workers: [{ name: "Writer", agentId: "1", state: "running" }], leadAgentId: null, costUsd: 0, createdAt: 1, endedAt: null, error: null };

test("saved successful results recover as finished agents and a reviewable task", () => {
  assert.equal(recoverAgent(snapshot).status, "idle");
  const task = recoverMission(mission, [view]);
  assert.equal(task.status, "ready");
  assert.equal(task.workers[0]!.state, "done");
  assert.equal(task.endedAt, null);
});

test("incomplete or queued work is paused instead of inferred complete", () => {
  for (const patch of [{ runId: "active-run" }, { pendingMessages: 1 }, { events: [{ at: 2, kind: "steer" as const, text: "Also add a chart" }] }, { status: "blocked" as const }]) {
    assert.equal(recoverAgent({ ...snapshot, ...patch }).status, "paused");
  }
});

test("recovery never skips waiting dependencies or an unfinished synthesis lead", () => {
  const withWaiting: MissionView = { ...mission, workers: [...mission.workers, { name: "Charts", agentId: null, state: "waiting" }] };
  const withLead: MissionView = { ...mission, allocation: { reasoning: "Combine work", workstreams: [], synthesis: true, leadStepIds: [] } };
  assert.equal(recoverMission(withWaiting, [view]).status, "failed");
  assert.equal(recoverMission(withLead, [view]).status, "failed");
  assert.equal(recoverMission(mission, [{ ...view, status: "paused" }]).status, "failed");
});
