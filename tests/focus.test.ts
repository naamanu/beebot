import assert from "node:assert/strict";
import { test } from "node:test";
import { plainIncidentStatus } from "../web/lib/incident-status.ts";
import type { AgentView, IncidentView } from "../server/types.ts";

const incident = (extra: Partial<IncidentView> = {}): IncidentView => ({
  id: "inc", title: "Checkout", severity: "SEV1", status: "investigating", declaredAt: 0, impactAt: 0, mitigatedAt: null, errorRate: [],
  findings: [], timeline: [], statusPosts: [], hasPostmortem: false, postmortemState: "none", jamieMeetingId: null, declaredBy: "watchtower", fixAppliedAt: null, ...extra,
});
const agent = (approval: boolean): AgentView => ({
  id: "1", missionId: null, task: "x", status: approval ? "blocked" : "working", events: [], costUsd: 0, runId: null, template: "incident", role: "Changes", title: null, startsAt: null,
  approval: approval ? { id: "a", agentId: "1", tool: "rollback_deploy", summary: "Roll back deploy #482", input: {}, at: 0 } : null,
});

test("plain status follows what is happening, not a hand-set field", () => {
  assert.equal(plainIncidentStatus(incident(), [agent(false)]).label, "Investigating");
  assert.equal(plainIncidentStatus(incident(), [agent(true)]).label, "Fix waiting for you");
  assert.equal(plainIncidentStatus(incident({ fixAppliedAt: 10 }), [agent(false)]).label, "Recovering");
  assert.equal(plainIncidentStatus(incident({ status: "resolved", fixAppliedAt: 10 }), []).label, "Resolved");
  assert.equal(plainIncidentStatus(incident(), [], true).label, "Fix waiting for you", "a fix the tower proposed itself");
  const calm = [8, 0.6, 0.5, 0.4, 0.5].map((v, t) => ({ t, v }));
  assert.equal(plainIncidentStatus(incident({ fixAppliedAt: 10, errorRate: calm }), []).label, "Back to normal");
  assert.equal(plainIncidentStatus(incident({ errorRate: calm }), []).label, "Investigating", "calm without a fix is not recovery");
});
