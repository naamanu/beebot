// Content from a real recorded run against the simulated store
// (data/postmortems/inc-mvmmrvlm.*). Findings are shortened for the screen,
// keeping their numbers. Times on screen follow that run.

export const DEPLOY = {
  id: "#482",
  service: "payments-api",
  by: "sam",
  message: "perf: tune DB pool and retry policy",
  diff: [
    { key: "DB_POOL_MAX", from: "50", to: "5" },
    { key: "PAYMENT_RETRY_ATTEMPTS", from: "3", to: "6" },
  ],
};

export const TITLE = "Checkout errors at 10% after deploy #482";

export const ALERT =
  "Heads up: checkout errors jumped to 9.6 percent at 16:46, 21 seconds after deploy 482 to payments-api by sam. I've started four investigators. Say “stand down” to cancel.";

export type Role = "Logs" | "Changes" | "Metrics" | "Comms";

export const AGENTS: { role: Role; job: string }[] = [
  { role: "Logs", job: "Error signatures and where failures start" },
  { role: "Changes", job: "Recent deploys and config changes" },
  { role: "Metrics", job: "Blast radius and red herrings" },
  { role: "Comms", job: "Public status page updates" },
];

// at: fraction of the investigate scene when the finding lands
export const FINDINGS: { role: Role; time: string; text: string; at: number }[] = [
  { role: "Comms", time: "16:46:20", at: 0.1, text: "checkout-api errors jumped 0.4% → 11.0%; logs show payments-api POST /v1/charges 504 after 5000ms." },
  { role: "Logs", time: "16:46:27", at: 0.26, text: "payments-api: “timeout acquiring connection from pool (max=5, in_use=5, waiting=127)”, right after pool changed 50 → 5." },
  { role: "Changes", time: "16:46:28", at: 0.42, text: "Deploy #482 cut DB_POOL_MAX from 50 to 5. Normal usage is 6–12 connections." },
  { role: "Changes", time: "16:46:29", at: 0.56, text: "External payment provider ruled out: 0.1% errors, EU health probes all 200." },
  { role: "Metrics", time: "16:46:32", at: 0.7, text: "Blast radius: payments-api 0.2% → 13.0%, p95 120ms → 2253ms. search-api flat at its 1.2% baseline." },
];

export const VOICE_ASK = "Logs, what are you seeing?";
export const VOICE_REPLY =
  "Logs says payments-api is timing out waiting for database connections. The pool dropped from 50 to 5 right after deploy 482.";

export const ROLLBACK = {
  summary: "Roll back deploy #482",
  by: "Changes",
  why: "#482 cut DB_POOL_MAX 50 → 5 and pool timeouts started 30s later. Provider and other deploys ruled out.",
  cites: [2, 3, 4],
  done: "Rolled back #482 on payments-api. Rollout complete in 20s.",
};

export const POSTMORTEM = {
  meta: "SEV1 · customer impact about 90 seconds · resolved",
  summary:
    "Deploy #482 to payments-api lowered DB_POOL_MAX from 50 to 5, below normal demand of about 6–12 connections, and raised PAYMENT_RETRY_ATTEMPTS from 3 to 6. Together these exhausted the database connection pool and checkout requests failed. The watchtower detected the spike 21 seconds after the deploy, and the deploy was rolled back 24 seconds after the incident was declared.",
  impact: [
    "checkout-api errors peaked at 18.8% (504s from payments-api)",
    "payments-api p95 latency ~120ms → ~2253ms",
    "Not affected: search-api, cdn, the external payment provider",
  ],
  timeline: [
    ["16:45:49", "Deploy #482 to payments-api", "sam"],
    ["16:46:10", "Detected and declared", "watchtower"],
    ["16:46:27", "Pool exhaustion found in logs", "Logs"],
    ["16:46:34", "Rollback approved", "commander"],
    ["16:47:26", "Checkout errors back to 0.4%", "Metrics"],
  ],
};

// Checkout error rate (%), one point per 5-second check.
const base = [0.4, 0.5, 0.4, 0.3, 0.5, 0.4, 0.4, 0.5, 0.3, 0.4, 0.5, 0.4, 0.4, 0.3, 0.5, 0.4];
export const SERIES_HEALTHY = base;
export const SERIES_SPIKE = [...base, 3.1, 9.6, 11.0];
export const SERIES_PEAK = [...SERIES_SPIKE, 13.4, 16.2, 18.4, 18.8];
export const SERIES_RECOVERY = [...SERIES_PEAK, 17.9, 9.2, 2.1, 0.6, 0.4, 0.5, 0.4];
