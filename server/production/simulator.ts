import { SERVICES, ShopfrontSim, type Metric, type Service } from "../incident/sim.ts";
import type { ActionResult, DemoControls, Deploy, HealthSignal, MetricInfo, Point, ProductionSource } from "./source.ts";

// The Shopfront simulator behind the ProductionSource interface. The
// simulation itself stays synchronous and deterministic (see sim.ts); this
// adapter only translates.
export class SimulatorSource implements ProductionSource {
  readonly id = "simulator";
  readonly label = "Shopfront (simulated)";
  readonly simulated = true;
  readonly health: HealthSignal = { service: "checkout-api", metric: "error_rate", label: "checkout errors", thresholdPct: 5 };
  readonly metrics: readonly MetricInfo[] = [
    { name: "error_rate", description: "error_rate (%)" },
    { name: "p95_latency_ms", description: "p95_latency_ms" },
    { name: "rps", description: "rps" },
    { name: "db_pool_in_use", description: "db_pool_in_use" },
    { name: "cache_hit_ratio", description: "cache_hit_ratio (%)" },
  ];
  readonly demo: DemoControls;

  constructor(readonly sim = new ShopfrontSim(Date.now(), { outage: false })) {
    const s = sim;
    this.demo = {
      get broken() { return s.broken; },
      injectOutage: (at, cdnAt) => s.injectOutage(at, cdnAt),
      injectProviderOutage: (at) => s.injectProviderOutage(at),
      recoverProvider: (at) => s.recoverProvider(at),
      restore: (at) => s.restoreForDemo(at),
    };
  }

  async services(): Promise<string[]> {
    return [...SERVICES];
  }

  async series(service: string, metric: string, windowMinutes: number, now = Date.now()): Promise<Point[]> {
    return this.sim.series(service as Service, metric as Metric, windowMinutes, now);
  }

  async logs(service: string, sinceMinutes: number, contains?: string, now = Date.now()): Promise<string[]> {
    return this.sim.logs(service as Service, sinceMinutes, contains, now);
  }

  async deploys(now = Date.now()): Promise<Deploy[]> {
    return this.sim.deploys.filter((d) => d.at <= now).map((d) => ({ ...d }));
  }

  async rollback(deployId: string): Promise<ActionResult> {
    const message = this.sim.rollback(deployId);
    return { ok: message.startsWith("Rolled back"), message };
  }

  async restart(service: string): Promise<ActionResult> {
    const message = this.sim.restart(service as Service);
    return { ok: message.startsWith("Restarted"), message };
  }

  async postStatus(status: string, message: string): Promise<ActionResult> {
    return { ok: true, message: this.sim.postStatus(status, message) };
  }

  impactStartedAt(): number | null {
    return this.sim.broken || this.sim.fixedAt !== null ? this.sim.impactAt : null;
  }

  remediatedAt(): number | null {
    return this.sim.fixedAt;
  }
}
