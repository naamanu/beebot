import assert from "node:assert/strict";
import { test } from "node:test";
import { Incident } from "../server/incident/incident.ts";
import { Jamie } from "../server/incident/jamie.ts";
import { ShopfrontSim } from "../server/incident/sim.ts";
import { IncidentStore } from "../server/incident/store.ts";
import { createProductionSource } from "../server/production/index.ts";
import { SimulatorSource } from "../server/production/simulator.ts";
import type { ActionResult, Deploy, Point, ProductionSource } from "../server/production/source.ts";
import { Watchtower } from "../server/watch/watchtower.ts";

// A real-backend-shaped source: no demo controls, no remediation knowledge.
class FakeSource implements ProductionSource {
  readonly id = "fake";
  readonly label = "Fake stack";
  readonly simulated = false;
  readonly health = { service: "api", metric: "error_rate", label: "API errors", thresholdPct: 5 };
  readonly metrics = [{ name: "error_rate", description: "error_rate (%)" }];
  rate = 20;
  failing = false;
  deployList: Deploy[] = [{ id: "7", service: "api", author: "kim", at: Date.now() - 60_000, message: "change", diff: "- a\n+ b", rolledBackAt: null }];
  async services() { return ["api"]; }
  async series(_s: string, _m: string, _w: number, now = Date.now()): Promise<Point[]> {
    if (this.failing) throw new Error("connection refused");
    return [0, 1, 2, 3].map((i) => ({ t: now - (3 - i) * 5000, v: this.rate }));
  }
  async logs() { return []; }
  async deploys() { return this.deployList.map((d) => ({ ...d })); }
  async rollback(id: string): Promise<ActionResult> {
    const d = this.deployList.find((x) => x.id === id);
    if (!d) return { ok: false, message: `No deploy #${id}.` };
    d.rolledBackAt = Date.now();
    this.rate = 0.2;
    return { ok: true, message: `Rolled back #${id}.` };
  }
  async restart(service: string): Promise<ActionResult> { return { ok: true, message: `Restarted ${service}.` }; }
  async postStatus(): Promise<ActionResult> { return { ok: true, message: "Posted." }; }
}

test("the simulator is the default source and unknown sources fail clearly", () => {
  assert.equal(createProductionSource().id, "simulator");
  assert.throws(() => createProductionSource("datadog"), /Unknown PRODUCTION_SOURCE "datadog"/);
});

test("an incident renders from a polled snapshot and tracks its own rollback on sources without remediation info", async () => {
  const source = new FakeSource();
  const incident = new Incident("API errors", "SEV1", new Jamie(undefined), () => {}, source, { detectedAt: 1234 });
  assert.deepEqual(incident.view().errorRate, [], "nothing is fetched synchronously");
  await incident.refresh();
  assert.equal(incident.view().errorRate.at(-1)?.v, 20);
  assert.equal(incident.view().impactAt, 1234, "detection time stands in for impact start");
  assert.equal(incident.view().source?.simulated, false);
  assert.equal(incident.fixAppliedAt, null);
  assert.equal((await incident.rollback("#404", "tower")).ok, false);
  assert.equal(incident.fixAppliedAt, null, "a failed rollback is not a fix");
  assert.equal((await incident.rollback("#7", "tower")).ok, true);
  assert.ok(incident.fixAppliedAt);
  await incident.refresh();
  assert.equal(incident.deploys[0]!.rolledBackAt !== null, true);
});

test("a backend outage keeps the last good snapshot instead of blanking the incident", async (t) => {
  t.mock.method(console, "warn", () => {});
  const source = new FakeSource();
  const incident = new Incident("API errors", "SEV1", new Jamie(undefined), () => {}, source);
  await incident.refresh();
  source.failing = true;
  await incident.refresh();
  assert.equal(incident.view().errorRate.length, 4);
});

test("the watchtower treats an unreachable backend as no data and reports it", async () => {
  const source = new FakeSource();
  const fired: unknown[] = [];
  const w = new Watchtower(source, (a) => fired.push(a), { sustain: 2 });
  source.failing = true;
  for (let i = 0; i < 3; i++) await w.check();
  assert.equal(fired.length, 0);
  assert.equal(w.view().error, "connection refused");
  source.failing = false;
  await w.check();
  await w.check();
  assert.equal(fired.length, 1);
  assert.equal(w.view().error, undefined);
  assert.equal(w.view().source?.demo, false);
});

test("skipping checks on a real source closes the investigation without a demo reset", async () => {
  const incident = new Incident("API errors", "SEV1", new Jamie(undefined), () => {}, new FakeSource());
  incident.review.view = { state: "ready", error: null, costUsd: 0, decision: { action: "investigate", deployId: null, reason: "Unclear.", findingIds: [], missingEvidence: ["Check the database."] } };
  incident.skipInvestigation("commander");
  assert.equal(incident.skippedInvestigation?.demoRecoveryAt, undefined);
  assert.equal(incident.timeline.some((e) => /Demo reset/.test(e.text)), false);
  assert.deepEqual(incident.skippedInvestigation?.openQuestions, ["Check the database."]);
});

test("incidents round-trip through the store and restore as interrupted", async () => {
  const store = new IncidentStore(":memory:");
  const sim = new ShopfrontSim(Date.now(), { outage: false });
  sim.injectOutage(Date.now() - 5 * 60_000);
  const source = new SimulatorSource(sim);
  const live = new Incident("Checkout", "SEV1", new Jamie(undefined), () => {}, source, { declaredBy: "watchtower" });
  await live.refresh();
  live.findings.push({ at: Date.now(), agentId: "1", role: "Logs", text: "Pool exhausted." });
  live.statusPosts.push({ at: Date.now(), status: "investigating", message: "Looking into it." });
  live.postmortem = "# Postmortem";
  store.save(live.record());

  assert.equal(store.lastOpen()?.id, live.id);
  assert.deepEqual(store.list().map((s) => [s.id, s.findings, s.hasPostmortem]), [[live.id, 1, true]]);

  // After a restart the simulator is healthy again; the saved impact start survives.
  const fresh = new SimulatorSource();
  const restored = new Incident("ignored", "SEV2", new Jamie(undefined), () => {}, fresh, { restore: store.get(live.id)! });
  const v = restored.view();
  assert.equal(v.id, live.id);
  assert.equal(v.declaredBy, "watchtower");
  assert.equal(v.impactAt, live.impactAt);
  assert.equal(v.findings.length, 1);
  assert.equal(v.statusPosts.length, 1);
  assert.equal(v.postmortemState, "ready");
  assert.equal(v.interrupted, true);
  assert.equal(v.errorRate.length, live.series.length, "the last snapshot shows until the next poll");
  await restored.refresh();
  assert.ok(restored.deploys.some((d) => d.service === "payments-api" && /DB pool/.test(d.message)), "the culprit deploy stays in the evidence after the simulator restarts");

  restored.setStatus("resolved", "commander");
  store.save(restored.record());
  assert.equal(store.lastOpen(), null, "resolved incidents are history, not restored");
  assert.equal(store.list()[0]!.status, "resolved");
  store.close();
});
