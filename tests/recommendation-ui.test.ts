import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecommendationPanel } from "../web/components/incident/recommendation-panel.tsx";
import { plainIncidentStatus } from "../web/lib/incident-status.ts";
import type { IncidentRecommendation, IncidentView } from "../server/types.ts";

const incident: IncidentView = {
  id: "inc", title: "Checkout", severity: "SEV1", status: "investigating", declaredAt: 0, impactAt: 0, mitigatedAt: null, errorRate: [],
  findings: [{ at: 1, agentId: "1", role: "Logs", text: "External provider returned 503; local pool is healthy." }],
  timeline: [], statusPosts: [], hasPostmortem: false, postmortemState: "none", jamieMeetingId: null, declaredBy: "watchtower", fixAppliedAt: null, canSkipInvestigation: true,
};
const base: IncidentRecommendation = { state: "none", decision: null, error: null, costUsd: 0 };
const render = (recommendation: IncidentRecommendation) => renderToStaticMarkup(createElement(RecommendationPanel, { incident: { ...incident, recommendation } }));

test("an evidence review displays loading and retryable error states without an approval button", () => {
  assert.equal(render(base), "");
  assert.match(render({ ...base, state: "reviewing" }), /Reviewing the investigators/);
  const error = render({ ...base, state: "error", error: "Request timed out" });
  assert.match(error, /No fix was proposed/);
  assert.match(error, /Retry evidence review/);
  assert.doesNotMatch(error, />Approve</);
});

test("an investigate decision shows cited evidence and actionable next checks", () => {
  const review: IncidentRecommendation = { ...base, state: "ready", decision: {
    action: "investigate", deployId: null, reason: "No evidence supports a local rollback.", findingIds: [1], missingEvidence: ["Check provider status and failover options."],
  } };
  const html = render(review);
  assert.match(html, /More investigation needed/);
  assert.match(html, /External provider returned 503/);
  assert.match(html, /Check provider status and failover options/);
  assert.match(html, /Skip checks and finish/);
  assert.match(html, /reset simulated services to healthy/);
  assert.doesNotMatch(html, />Approve</);
  assert.equal(plainIncidentStatus({ ...incident, recommendation: review }, []).label, "More evidence needed");
});

test("a skipped investigation keeps unanswered checks visible after closure", () => {
  const html = renderToStaticMarkup(createElement(RecommendationPanel, { incident: {
    ...incident, status: "resolved", recommendation: base,
    skippedInvestigation: { at: 2, by: "commander", reason: "Provider failure", recoveryConfirmed: false, openQuestions: ["Confirm the provider recovery ETA."] },
  } }));
  assert.match(html, /Investigation closed with open questions/);
  assert.match(html, /Recovery is unconfirmed/);
  assert.match(html, /Confirm the provider recovery ETA/);
  assert.doesNotMatch(html, /Skip checks and finish/);
});

test("an older running backend does not expose a button for an unsupported command", () => {
  const html = renderToStaticMarkup(createElement(RecommendationPanel, { incident: {
    ...incident, canSkipInvestigation: undefined, recommendation: { ...base, state: "ready", decision: {
      action: "investigate", deployId: null, reason: "Provider failure", findingIds: [1], missingEvidence: ["Check provider status."],
    } },
  } }));
  assert.match(html, /More investigation needed/);
  assert.doesNotMatch(html, /Skip checks and finish/);
});


test("a demo closure shows healthy status while retaining unanswered checks", () => {
  const closed: IncidentView = { ...incident, status: "resolved", skippedInvestigation: {
    at: 2, by: "commander", reason: "Provider failure", recoveryConfirmed: false, demoRecoveryAt: 2,
    openQuestions: ["Confirm the provider recovery ETA."],
  } };
  const html = renderToStaticMarkup(createElement(RecommendationPanel, { incident: closed }));
  assert.match(html, /Demo services reset to healthy/);
  assert.match(html, /Confirm the provider recovery ETA/);
  assert.doesNotMatch(html, /Recovery is unconfirmed/);
  assert.deepEqual(plainIncidentStatus(closed, []), { label: "Resolved (demo reset)", tone: "good" });
});
