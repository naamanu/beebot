import assert from "node:assert/strict";
import { test } from "node:test";
import { ShopfrontSim } from "../server/incident/sim.ts";
import { Watchtower, anomalyBriefing, type Anomaly } from "../server/watch/watchtower.ts";
import { closingBriefing, incidentBriefing } from "../server/watch/briefing.ts";
import type { IncidentView } from "../server/types.ts";

const MIN = 60_000;

test("a healthy store raises nothing", () => {
  const t0 = Date.now();
  const sim = new ShopfrontSim(t0, { outage: false });
  const fired: Anomaly[] = [];
  const w = new Watchtower(sim, (a) => fired.push(a));
  for (let i = 0; i < 10; i++) w.check(t0 + i * 5000);
  assert.equal(fired.length, 0);
  assert.equal(w.view(t0).state, "healthy");
});

test("a bad deploy is detected once the breach is sustained, with the deploy as suspect", () => {
  const t0 = Date.now();
  const sim = new ShopfrontSim(t0, { outage: false });
  const { badDeployId } = sim.injectOutage(t0);
  const fired: Anomaly[] = [];
  const w = new Watchtower(sim, (a) => fired.push(a));
  // The error rate ramps over ~90s; the first breaching check alone doesn't fire.
  for (let t = t0; t <= t0 + 2 * MIN; t += 5000) w.check(t);
  assert.equal(fired.length, 1);
  assert.equal(fired[0]!.suspect?.id, badDeployId);
  assert.ok(fired[0]!.errorRate >= 5);
  assert.match(anomalyBriefing(fired[0]!), new RegExp(`deploy ${badDeployId} to payments-api by sam`));
});

test("the briefing says how long after the deploy, in words that read right", () => {
  const deploy = { id: "482", service: "payments-api", author: "sam", at: 0, message: "", diff: "", rolledBackAt: null };
  assert.match(anomalyBriefing({ errorRate: 7, since: 12_000, suspect: deploy }), /12 seconds after deploy 482/);
  assert.match(anomalyBriefing({ errorRate: 7, since: 60_000, suspect: deploy }), /1 minute after deploy 482/);
  assert.match(anomalyBriefing({ errorRate: 7, since: 240_000, suspect: deploy }), /4 minutes after deploy 482/);
});

test("it fires once per outage and re-arms only after recovery", () => {
  const t0 = Date.now();
  const sim = new ShopfrontSim(t0, { outage: false });
  const { badDeployId } = sim.injectOutage(t0);
  const fired: Anomaly[] = [];
  const w = new Watchtower(sim, (a) => fired.push(a));
  for (let t = t0; t <= t0 + 4 * MIN; t += 5000) w.check(t);
  assert.equal(fired.length, 1, "no repeat while still broken");
  sim.rollback(badDeployId, t0 + 4 * MIN);
  for (let t = t0 + 4 * MIN; t <= t0 + 7 * MIN; t += 5000) w.check(t);
  sim.injectOutage(t0 + 8 * MIN);
  for (let t = t0 + 8 * MIN; t <= t0 + 10 * MIN; t += 5000) w.check(t);
  assert.equal(fired.length, 2, "a new outage after recovery fires again");
});

test("standing down suppresses the current breach; turning it off suppresses all", () => {
  const t0 = Date.now();
  const sim = new ShopfrontSim(t0, { outage: false });
  sim.injectOutage(t0);
  const fired: Anomaly[] = [];
  const off = new Watchtower(sim, (a) => fired.push(a));
  off.enabled = false;
  for (let t = t0; t <= t0 + 2 * MIN; t += 5000) off.check(t);
  assert.equal(fired.length, 0);
  const disarmed = new Watchtower(sim, (a) => fired.push(a));
  disarmed.disarm();
  disarmed.check(t0 + 2 * MIN);
  disarmed.check(t0 + 2 * MIN + 5000);
  assert.equal(fired.length, 0);
});

function view(errorRates: number[], extra: Partial<IncidentView> = {}): IncidentView {
  return {
    id: "inc", title: "Checkout", severity: "SEV1", status: "investigating", declaredAt: 0, impactAt: 0, mitigatedAt: null,
    errorRate: errorRates.map((v, i) => ({ t: i, v })), findings: [], timeline: [], statusPosts: [], hasPostmortem: false, postmortemState: "none", jamieMeetingId: null, declaredBy: "commander", fixAppliedAt: null, ...extra,
  };
}

test("briefings speak only when something changed", () => {
  const first = incidentBriefing(view([37]), [], null)!;
  assert.match(first.text, /checkout errors at 37 percent/);
  assert.equal(incidentBriefing(view([37.5]), [], first.state), null, "a small wobble isn't news");
  const falling = incidentBriefing(view([30, 20, 12], { findings: [{ at: 1, agentId: "1", role: "Logs", text: "x" }] }), [], first.state)!;
  assert.match(falling.text, /12 percent, falling; 1 new finding/);
  // Higher than at the last briefing, but coming down now: that's falling.
  const peakedThenFalling = incidentBriefing(view([37, 20, 12]), [], incidentBriefing(view([7]), [], null)!.state)!;
  assert.match(peakedThenFalling.text, /12 percent, falling/);
});

test("the closing briefing sums up impact", () => {
  const text = closingBriefing(view([0.4], { impactAt: 0, mitigatedAt: 11 * MIN, findings: [{ at: 1, agentId: "1", role: "Logs", text: "x" }], statusPosts: [{ at: 1, status: "identified", message: "m" }] }));
  assert.match(text, /about 11 minutes; 1 findings recorded and 1 status update posted/);
});
