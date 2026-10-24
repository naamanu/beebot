import assert from "node:assert/strict";
import { test } from "node:test";
import { ShopfrontSim } from "../server/incident/sim.ts";
import { Watchtower } from "../server/watch/watchtower.ts";
import { clientMessageSchema } from "../server/protocol.ts";

test("provider failures trigger detection without a causal deploy or pool exhaustion", () => {
  const start = Date.now();
  const sim = new ShopfrontSim(start, { outage: false });
  const deploys = structuredClone(sim.deploys);
  sim.injectProviderOutage(start);
  const anomalies: unknown[] = [];
  const watch = new Watchtower(sim, (a) => anomalies.push(a));
  for (let t = start; t <= start + 120_000; t += 5000) watch.check(t);
  assert.equal(anomalies.length, 1);
  assert.deepEqual(sim.deploys, deploys);
  assert.equal(sim.badDeploy, null);
  assert.equal(sim.broken, true);
  assert.equal(sim.impactAt, start);
  assert.ok(sim.metric("checkout-api", "error_rate", start + 120_000) > 30);
  assert.ok(sim.metric("payment-provider", "error_rate", start + 120_000) > 80);
  assert.ok(sim.metric("payments-api", "db_pool_in_use", start + 120_000) < 15);
  assert.match(sim.logs("payments-api", 1, undefined, start + 120_000).join("\n"), /payment-provider.*503/);
  assert.match(sim.logs("payment-provider", 1, undefined, start + 120_000).join("\n"), /external health probe.*503/);
});

test("local rollbacks and restarts do not fix an external provider outage", () => {
  const start = Date.now();
  const sim = new ShopfrontSim(start, { outage: false });
  sim.injectProviderOutage(start);
  sim.rollback("481", start + 120_000);
  sim.restart("payments-api", start + 120_000);
  assert.match(sim.restart("payment-provider"), /externally operated/);
  assert.equal(sim.fixedAt, null);
  assert.equal(sim.broken, true);
  assert.ok(sim.metric("checkout-api", "error_rate", start + 130_000) > 30);
});

test("explicit simulated provider recovery restores health and rearms detection", () => {
  const start = Date.now();
  const sim = new ShopfrontSim(start, { outage: false });
  assert.equal(sim.recoverProvider(start), false);
  sim.injectProviderOutage(start);
  const watch = new Watchtower(sim, () => {});
  for (let t = start; t < start + 120_000; t += 5000) watch.check(t);
  assert.equal(sim.recoverProvider(start + 120_000), true);
  assert.equal(sim.fixedAt, start + 120_000);
  assert.equal(sim.recoverProvider(start + 130_000), false);
  watch.check(start + 180_000);
  assert.equal(watch.view().state, "healthy");
  assert.equal(sim.broken, false);
  sim.injectOutage(start + 240_000);
  let detected = false;
  for (let t = start + 240_000; t < start + 360_000; t += 5000) detected ||= !!watch.check(t);
  assert.equal(detected, true);
});

test("a deploy outage still recovers after rollback, with a healthy external provider", () => {
  const start = Date.now();
  const sim = new ShopfrontSim(start);
  assert.ok(sim.metric("payments-api", "db_pool_in_use", start) <= 5);
  assert.ok(sim.metric("payment-provider", "error_rate", start) < 1);
  assert.match(sim.logs("payments-api", 1, undefined, start).join("\n"), /timeout acquiring connection/);
  sim.rollback("482", start);
  assert.ok(sim.metric("checkout-api", "error_rate", start + 60_000) < 1);
});

test("scenario controls preserve the original message and reject unknown scenarios", () => {
  assert.equal(clientMessageSchema.safeParse({ type: "simulate_outage" }).success, true);
  assert.equal(clientMessageSchema.safeParse({ type: "simulate_outage", scenario: "provider" }).success, true);
  assert.equal(clientMessageSchema.safeParse({ type: "simulate_outage", scenario: "anything" }).success, false);
  assert.equal(clientMessageSchema.safeParse({ type: "recover_provider" }).success, true);
  assert.equal(clientMessageSchema.safeParse({ type: "retry_recommendation" }).success, true);
});


for (const scenario of ["deploy", "provider"] as const) {
  test(`demo reset restores ${scenario} errors instantly, preserves history and permits another drill`, () => {
    const start = Date.now();
    const sim = new ShopfrontSim(start, { outage: false });
    if (scenario === "deploy") sim.injectOutage(start);
    else sim.injectProviderOutage(start);
    const watch = new Watchtower(sim, () => {});
    for (let t = start; t <= start + 120_000; t += 5000) watch.check(t);
    const history = sim.series("checkout-api", "error_rate", 1, start + 110_000);
    const deploys = structuredClone(sim.deploys);
    const reset = start + 120_000;
    sim.restoreForDemo(reset);
    watch.check(reset);
    assert.equal(watch.view(reset).state, "healthy");
    assert.equal(sim.broken, false);
    assert.equal(sim.fixedAt, reset);
    assert.ok(sim.metric("checkout-api", "error_rate", reset) < 1);
    assert.ok(sim.metric("payments-api", "error_rate", reset) < 1);
    assert.ok(sim.metric("payment-provider", "error_rate", reset) < 1);
    assert.ok(sim.metric("payments-api", "db_pool_in_use", reset) > 5);
    assert.deepEqual(sim.series("checkout-api", "error_rate", 1, start + 110_000), history);
    assert.deepEqual(sim.deploys, deploys);
    sim.restoreForDemo(reset + 1000);
    assert.equal(sim.fixedAt, reset, "repeated reset keeps its original timestamp");
    assert.equal(sim.recoverProvider(reset + 1000), false);
    // Reset state must be cleared by either kind of next drill.
    if (scenario === "deploy") sim.injectProviderOutage(reset + 60_000);
    else sim.injectOutage(reset + 60_000);
    assert.equal(sim.fixedAt, null);
    let detected = false;
    for (let t = reset + 60_000; t <= reset + 180_000; t += 5000) detected ||= !!watch.check(t);
    assert.equal(detected, true);
  });
}
