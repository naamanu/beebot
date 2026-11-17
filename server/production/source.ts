// The production system Control Tower watches and acts on. Investigators,
// the watchtower and the evidence review reach production only through this
// interface, so the Shopfront simulator and real backends (Prometheus/Loki,
// GitHub deploys) are interchangeable.
//
// Reads and actions are async because real backends are HTTP APIs. Callers
// that render synchronously (incident views, the watch bar) poll and cache.

export interface Point {
  t: number; // epoch ms
  v: number;
}

export interface Deploy {
  id: string;
  service: string;
  author: string;
  at: number;
  message: string;
  diff: string;
  rolledBackAt: number | null;
}

export interface StatusPost {
  at: number;
  status: string;
  message: string;
}

export interface ActionResult {
  ok: boolean; // the action took effect
  message: string; // one human-readable line for the timeline and the agent
}

export interface MetricInfo {
  name: string;
  description: string; // shown to the agents, e.g. "error_rate (%)"
}

// The one signal the watchtower watches for a sustained breach.
export interface HealthSignal {
  service: string;
  metric: string;
  label: string; // spoken and shown: "checkout errors"
  thresholdPct: number;
}

// Controls that only make sense for a simulated system. Real sources leave
// `demo` undefined, and the UI hides the drills.
export interface DemoControls {
  readonly broken: boolean; // an injected outage is ongoing
  injectOutage(at?: number, cdnAt?: number): { badDeployId: string };
  injectProviderOutage(at?: number): void;
  recoverProvider(at?: number): boolean;
  restore(at?: number): void; // explicit demo reset to healthy
}

export interface ProductionSource {
  readonly id: string; // "simulator", "stack"
  readonly label: string; // "Shopfront (simulated)"
  readonly simulated: boolean;
  readonly health: HealthSignal;
  readonly metrics: readonly MetricInfo[];
  readonly demo?: DemoControls;

  services(): Promise<string[]>;
  series(service: string, metric: string, windowMinutes: number, now?: number): Promise<Point[]>;
  logs(service: string, sinceMinutes: number, contains?: string, now?: number): Promise<string[]>;
  // Deploys that have landed by `now`, in any order.
  deploys(now?: number): Promise<Deploy[]>;

  // Consequential actions. Callers gate these behind human approval.
  rollback(deployId: string): Promise<ActionResult>;
  restart(service: string): Promise<ActionResult>;
  postStatus(status: string, message: string): Promise<ActionResult>;

  // Facts only some sources know. When absent, the incident falls back to
  // its own records (detection time, rollbacks it applied).
  impactStartedAt?(): number | null;
  remediatedAt?(): number | null;
}

// Validates names before they reach a backend query.
export async function assertService(source: ProductionSource, service: string): Promise<void> {
  const known = await source.services();
  if (!known.includes(service)) throw new Error(`Unknown service "${service}". Known services: ${known.join(", ")}.`);
}

export function assertMetric(source: ProductionSource, metric: string): void {
  if (!source.metrics.some((m) => m.name === metric)) throw new Error(`Unknown metric "${metric}". Known metrics: ${source.metrics.map((m) => m.name).join(", ")}.`);
}
