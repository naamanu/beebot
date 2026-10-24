import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { Incident } from "../server/incident/incident.ts";
import { Jamie } from "../server/incident/jamie.ts";
import { ShopfrontSim } from "../server/incident/sim.ts";
import { clientMessageSchema } from "../server/protocol.ts";
import { closingBriefing } from "../server/watch/briefing.ts";
import { plainIncidentStatus } from "../web/lib/incident-status.ts";

process.env.ANTHROPIC_API_KEY = "test-placeholder";

function providerIncident() {
  const sim = new ShopfrontSim(Date.now(), { outage: false });
  sim.injectProviderOutage(Date.now() - 120_000);
  const incident = new Incident("Provider outage", "SEV1", new Jamie(undefined), () => {}, sim);
  incident.review.view = { state: "ready", error: null, costUsd: 0, decision: {
    action: "investigate", deployId: null, reason: "The provider is failing; there is no causal local deploy.", findingIds: [],
    missingEvidence: ["Confirm provider status and recovery ETA.", "Check whether a supported failover exists."],
  } };
  return { sim, incident };
}

test("skipping preserves open questions and resets simulated health explicitly", () => {
  const { sim, incident } = providerIncident();
  assert.equal(incident.view().canSkipInvestigation, true);
  const open = [...incident.review.view.decision!.missingEvidence];
  const deploys = structuredClone(sim.deploys);
  const before = Date.now() - 1000;
  const historicalError = sim.metric("checkout-api", "error_rate", before);
  incident.skipInvestigation("commander");
  incident.setStatus("resolved", "commander");
  incident.review.invalidate();
  const view = incident.view();
  assert.deepEqual(view.skippedInvestigation?.openQuestions, open);
  assert.equal(view.skippedInvestigation?.recoveryConfirmed, false);
  assert.equal(view.status, "resolved", "the existing workflow can proceed to the postmortem and Jamie follow-ups");
  assert.equal(view.canSkipInvestigation, false);
  assert.equal(view.mitigatedAt, view.skippedInvestigation?.demoRecoveryAt);
  assert.equal(view.fixAppliedAt, view.mitigatedAt);
  assert.equal(sim.broken, false);
  assert.ok(sim.metric("checkout-api", "error_rate", Date.now()) < 1);
  assert.ok(sim.metric("payment-provider", "error_rate", Date.now()) < 1);
  assert.equal(sim.metric("checkout-api", "error_rate", before), historicalError);
  assert.deepEqual(sim.deploys, deploys, "demo reset must not fabricate a rollback");
  assert.match(view.timeline.find((e) => e.kind === "action")!.text, /Demo reset/);
  assert.match(view.timeline.find((e) => e.kind === "instruction")!.text, /Confirm provider status and recovery ETA/);
  assert.deepEqual(plainIncidentStatus(view, []), { label: "Resolved (demo reset)", tone: "good" });
  assert.match(closingBriefing(view), /Demo services have been reset to healthy/);
});

test("skipped questions are a snapshot, even if the recommendation is changed later", () => {
  const { incident } = providerIncident();
  incident.skipInvestigation("commander");
  incident.review.view.decision!.missingEvidence.push("A later question");
  assert.equal(incident.skippedInvestigation!.openQuestions.length, 2);
});

test("skip rejects absent, running and rollback reviews and already-closed investigations", () => {
  const { incident } = providerIncident();
  incident.review.view.state = "reviewing";
  assert.throws(() => incident.skipInvestigation("commander"), /no pending investigation checks/);
  incident.review.view.state = "none";
  assert.throws(() => incident.skipInvestigation("commander"), /no pending investigation checks/);
  incident.review.view.state = "ready";
  incident.review.view.decision!.action = "rollback";
  assert.throws(() => incident.skipInvestigation("commander"), /no pending investigation checks/);
  incident.status = "resolved";
  assert.throws(() => incident.skipInvestigation("commander"), /already closed/);
  assert.equal(incident.skippedInvestigation, undefined);
  assert.equal(incident.sim.broken, true, "rejected skips must leave the simulator untouched");
});

test("skip commands must name the incident whose checks the operator saw", () => {
  assert.equal(clientMessageSchema.safeParse({ type: "skip_investigation" }).success, false);
  assert.equal(clientMessageSchema.safeParse({ type: "skip_investigation", incidentId: "" }).success, false);
  assert.equal(clientMessageSchema.safeParse({ type: "skip_investigation", incidentId: "inc-1" }).success, true);
});

test("the postmortem distinguishes a demo reset from an agent fix and retains open checks", async (t) => {
  const { incident } = providerIncident();
  incident.skipInvestigation("commander");
  incident.setStatus("resolved", "commander");
  const sdk = new Anthropic({ apiKey: "test-placeholder" });
  let captured = "";
  t.mock.method(Object.getPrototypeOf(sdk.beta.messages), "stream", (request: { messages: { content: string }[] }) => {
    captured = request.messages[0]!.content;
    return { finalMessage: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "# Closed with open questions" }] }) };
  });
  const { writePostmortem } = await import("../server/incident/postmortem.ts");
  assert.equal(await writePostmortem(incident, [], null), "# Closed with open questions");
  assert.match(captured, /status="resolved by demo reset; open questions retained"/);
  assert.doesNotMatch(captured, /mitigated="not yet"/);
  assert.match(captured, /Confirm provider status and recovery ETA/);
  assert.match(captured, /Do not attribute recovery to an agent fix, rollback, or a proven diagnosis/);
});
