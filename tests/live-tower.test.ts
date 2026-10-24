import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTasks, isRecovered } from "../server/tasks.ts";
import type { AgentView, IncidentView } from "../server/types.ts";
import { looksMultiPart, shouldPlan } from "../web/lib/plan-mode.ts";

function investigator(id: string, status: AgentView["status"]): AgentView {
  return { id, missionId: null, task: "Investigate", status, events: [], costUsd: 0.1, runId: null, template: "incident", role: "Logs", title: null, startsAt: null, approval: null };
}

function incident(errorRates: number[], status: IncidentView["status"] = "investigating"): IncidentView {
  return {
    id: "inc-1", title: "Checkout failing", severity: "SEV1", status, declaredAt: 1, impactAt: 0, mitigatedAt: null,
    errorRate: errorRates.map((v, i) => ({ t: i, v })), findings: [], timeline: [], statusPosts: [], hasPostmortem: false, postmortemState: "none", jamieMeetingId: null, declaredBy: "commander", fixAppliedAt: null,
  };
}

test("an incident whose investigators all stopped is ready, not still working", () => {
  const [task] = buildTasks([investigator("1", "paused"), investigator("2", "idle")], [], incident([37, 12, 0.5, 0.4, 0.4, 0.3]));
  assert.equal(task!.status, "ready");
  assert.equal(task!.needs[0]?.label, "Errors are back to normal: resolve it?");
});

test("an incident with an investigator still active keeps working", () => {
  const [task] = buildTasks([investigator("1", "paused"), investigator("2", "working")], [], incident([0.4, 0.4, 0.4, 0.4]));
  assert.equal(task!.status, "working");
});

test("recovery needs the last few samples near baseline, not one dip", () => {
  assert.equal(isRecovered(incident([37, 36, 0.5, 35])), false);
  assert.equal(isRecovered(incident([37, 0.6, 0.5, 0.4, 0.4])), true);
});

test("typed multi-part requests get a plan in auto mode; spoken ones never do", () => {
  const multi = "Investigate the France dip, build a Q4 forecast per region, and write a one-page summary, then email it";
  assert.equal(looksMultiPart(multi), true);
  assert.equal(looksMultiPart("Add due dates to todos"), false);
  assert.equal(looksMultiPart("Two features: (1) priority field (2) stats module"), true);
  assert.equal(shouldPlan("auto", multi, false), true);
  assert.equal(shouldPlan("auto", multi, true), false);
  assert.equal(shouldPlan("auto", "Add due dates to todos", false), false);
  assert.equal(shouldPlan("on", "anything", true), true);
  assert.equal(shouldPlan("off", multi, false), false);
});
