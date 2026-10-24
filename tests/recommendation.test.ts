import assert from "node:assert/strict";
import { test } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { FindingsReview, reviewEvidence, reviewFindings, validateDecision, type EvidenceReviewer } from "../server/incident/recommendation.ts";
import { ShopfrontSim } from "../server/incident/sim.ts";
import type { IncidentDecision } from "../server/types.ts";

process.env.ANTHROPIC_API_KEY = "test-placeholder";

const now = Date.now();
const sim = new ShopfrontSim(now);
const findings = [
  { at: now, agentId: "1", role: "Logs", text: "Payments connection acquisition times out at max=5; checkout failures originate here." },
  { at: now, agentId: "2", role: "Changes", text: "Deploy #482 changed DB_POOL_MAX from 50 to 5 immediately before the pool timeouts began." },
];
const evidence = reviewEvidence(findings, sim.deploys, now);
const rollback: IncidentDecision = { action: "rollback", deployId: "482", reason: "The pool reduction matches the recorded saturation and timeout signature.", findingIds: [1, 2], missingEvidence: [] };
const investigate: IncidentDecision = { action: "investigate", deployId: null, reason: "External provider errors do not establish a causal local deploy.", findingIds: [1], missingEvidence: ["Confirm the provider's recovery estimate and assess a supported failover."] };

test("review inputs contain only recorded findings and deploy records already visible to investigators", () => {
  const future = { ...sim.deploys[0]!, id: "future", at: now + 1000 };
  const result = reviewEvidence(findings, [...sim.deploys, future], now);
  assert.deepEqual(Object.keys(result).sort(), ["deploys", "findings"]);
  assert.equal(result.deploys.some((d) => d.id === "future"), false);
  assert.deepEqual(result.findings.map((f) => f.id), [1, 2]);
  findings[0]!.text += " Updated.";
  assert.notEqual(result.findings[0]!.text, findings[0]!.text, "an in-flight review owns an immutable evidence snapshot");
});

test("a valid rollback cites actual findings and an available deploy", () => {
  assert.deepEqual(validateDecision(rollback, evidence), rollback);
  assert.throws(() => validateDecision({ ...rollback, deployId: "999" }, evidence), /unavailable deploy/);
  assert.throws(() => validateDecision(rollback, { ...evidence, deploys: evidence.deploys.map((d) => ({ ...d, rolledBackAt: now })) }), /unavailable deploy/);
  assert.throws(() => validateDecision({ ...rollback, findingIds: [] }, evidence), /must cite/);
  assert.throws(() => validateDecision({ ...rollback, findingIds: [99] }, evidence), /unknown finding/);
  assert.throws(() => validateDecision({ ...rollback, missingEvidence: ["Unknown failure mechanism"] }, evidence), /unresolved evidence/);
});

test("declining a rollback requires concrete next checks and has no deploy target", () => {
  assert.deepEqual(validateDecision(investigate, evidence), investigate);
  assert.throws(() => validateDecision({ ...investigate, deployId: "482" }, evidence), /cannot name/);
  assert.throws(() => validateDecision({ ...investigate, missingEvidence: [] }, evidence), /must explain/);
});

test("the model reviews public evidence once, with no simulator answer in its request", async (t) => {
  const sdk = new Anthropic({ apiKey: "test-placeholder" });
  t.mock.method(Object.getPrototypeOf(sdk.messages), "parse", async (request: { messages: { content: string }[] }, options: { timeout: number; maxRetries: number }) => {
    assert.deepEqual(JSON.parse(request.messages[0]!.content), evidence);
    assert.equal(options.timeout, 20_000);
    assert.equal(options.maxRetries, 0);
    return { parsed_output: rollback, model: "test", usage: { input_tokens: 10, output_tokens: 20 } };
  });
  const review = new FindingsReview(() => {});
  assert.deepEqual(await review.run(evidence), rollback);
  assert.equal(await review.run(evidence), null);
  assert.equal(review.view.state, "ready");
});

test("no findings asks for evidence without invoking a model", async (t) => {
  const sdk = new Anthropic({ apiKey: "test-placeholder" });
  t.mock.method(Object.getPrototypeOf(sdk.messages), "parse", () => { throw new Error("Unexpected model call"); });
  const empty = reviewEvidence([], sim.deploys, now);
  const result = await reviewFindings(empty, new AbortController().signal);
  assert.equal(validateDecision(result.decision, empty).action, "investigate");
});

test("provider findings can finish with next checks and no rollback proposal", async () => {
  const provider = new ShopfrontSim(now, { outage: false });
  provider.injectProviderOutage(now - 120_000);
  const input = reviewEvidence([{ at: now, agentId: "1", role: "Logs", text: provider.logs("payments-api", 1, undefined, now).join("\n") }], provider.deploys, now);
  const review = new FindingsReview(() => {}, async () => ({ decision: investigate, costUsd: 0.01 }));
  const result = await review.run(input);
  assert.equal(result?.action, "investigate");
  assert.equal(result?.deployId, null);
  assert.ok(result?.missingEvidence.length);
  assert.equal(review.view.costUsd, 0.01);
});

test("invalid or failed model responses produce an error once and retry only when requested", async () => {
  let calls = 0;
  const review = new FindingsReview(() => {}, async () => {
    calls++;
    if (calls === 1) return { decision: { ...rollback, deployId: "999" }, costUsd: 0 };
    if (calls === 2) throw new Error("Provider unavailable");
    return { decision: rollback, costUsd: 0 };
  });
  assert.equal(await review.run(evidence), null);
  assert.equal(review.view.state, "error");
  assert.equal(await review.run(evidence), null);
  assert.equal(calls, 1);
  review.invalidate();
  assert.equal(await review.run(evidence), null);
  assert.match(review.view.error!, /Provider unavailable/);
  review.invalidate();
  assert.deepEqual(await review.run(evidence), rollback);
});

test("duplicate ticks do not start another review while one is in progress", async () => {
  let finish!: (value: Awaited<ReturnType<EvidenceReviewer>>) => void;
  let calls = 0;
  const review = new FindingsReview(() => {}, async () => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const work = review.run(evidence);
  assert.equal(review.view.state, "reviewing");
  assert.equal(await review.run(evidence), null);
  assert.equal(calls, 1);
  finish({ decision: rollback, costUsd: 0 });
  await work;
});

test("closing or resuming an incident cancels a review and discards a late successful reply", async () => {
  let finish!: (value: Awaited<ReturnType<EvidenceReviewer>>) => void;
  let signal!: AbortSignal;
  const review = new FindingsReview(() => {}, async (_, abort) => { signal = abort; return new Promise((resolve) => { finish = resolve; }); });
  const work = review.run(evidence);
  review.invalidate();
  assert.equal(signal.aborted, true);
  finish({ decision: rollback, costUsd: 0 });
  assert.equal(await work, null);
  assert.equal(review.view.state, "none");
  assert.equal(review.view.decision, null);
});

test("new evidence supersedes a pending review even if its old model reply arrives last", async () => {
  let finish!: (value: Awaited<ReturnType<EvidenceReviewer>>) => void;
  let calls = 0;
  const review = new FindingsReview(() => {}, async () => {
    calls++;
    if (calls === 1) return new Promise((resolve) => { finish = resolve; });
    return { decision: investigate, costUsd: 0 };
  });
  const work = review.run(evidence);
  const updated = { ...evidence, findings: [...evidence.findings, { ...evidence.findings[0]!, id: 3, text: "External provider health probes fail; local database is healthy." }] };
  assert.equal((await review.run(updated))?.action, "investigate");
  finish({ decision: rollback, costUsd: 0 });
  assert.equal(await work, null);
  assert.equal(review.view.decision?.action, "investigate");
  assert.equal(review.matches(evidence), false);
});
