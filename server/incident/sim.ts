// A simulated production system with an outage, for incident-response demos.
//
// Story: deploy #482 to payments-api "tuned" the DB pool from 50 to 5.
// Payments starve for connections, checkout returns 5xx. Two red herrings:
// a CDN cache-hit dip from an unrelated config change (recovers by itself),
// and a search-api warning that has been there for hours.
// Rolling back #482 fixes it; restarting payments-api only helps briefly.

const MIN = 60_000;

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

export type Metric = "error_rate" | "p95_latency_ms" | "rps" | "db_pool_in_use" | "cache_hit_ratio";

export const SERVICES = ["web-frontend", "checkout-api", "payments-api", "search-api", "cdn"] as const;
export type Service = (typeof SERVICES)[number];

export class ShopfrontSim {
  readonly startedAt: number; // when the simulation began
  deploys: Deploy[];
  statusPosts: StatusPost[] = [];
  private restartedAt: number | null = null;
  private badId: string | null = null; // the deploy that broke payments, if any
  private cdnId: string | null = null; // the unrelated CDN change (a red herring)

  // outage: start with the classic drill already 9 minutes in. Without it the
  // store is healthy until injectOutage() lands a bad deploy.
  constructor(now = Date.now(), { outage = true } = {}) {
    this.startedAt = now;
    this.deploys = [
      {
        id: "479",
        service: "search-api",
        author: "maya",
        at: now - 190 * MIN,
        message: "Bump search ranking model to v7",
        diff: "- RANKING_MODEL=v6\n+ RANKING_MODEL=v7",
        rolledBackAt: null,
      },
      {
        id: "481",
        service: "web-frontend",
        author: "leo",
        at: now - 41 * MIN,
        message: "New checkout button styles",
        diff: "src/components/CheckoutButton.tsx | 14 +++++++-------\n- className=\"btn btn-primary\"\n+ className=\"btn btn-primary btn-lg rounded-full\"",
        rolledBackAt: null,
      },
    ];
    if (outage) this.injectOutage(now - 9 * MIN, now - 6 * MIN);
  }

  // A "perf tuning" deploy shrinks the payments DB pool; a CDN TTL change
  // lands a little later and muddies the water.
  injectOutage(at = Date.now(), cdnAt = at + 100_000): { badDeployId: string } {
    const nextId = () => String(Math.max(...this.deploys.map((d) => Number(d.id))) + 1);
    this.badId = nextId();
    this.deploys.push({
      id: this.badId,
      service: "payments-api",
      author: "sam",
      at,
      message: "perf: tune DB pool and retry policy",
      diff: "config/production.env\n- DB_POOL_MAX=50\n+ DB_POOL_MAX=5\n- PAYMENT_RETRY_ATTEMPTS=3\n+ PAYMENT_RETRY_ATTEMPTS=6",
      rolledBackAt: null,
    });
    this.cdnId = nextId();
    this.deploys.push({
      id: this.cdnId,
      service: "cdn",
      author: "ana",
      at: cdnAt,
      message: "Shorten cache TTL for /static to 5m",
      diff: "- cache_ttl /static/* 1h\n+ cache_ttl /static/* 5m",
      rolledBackAt: null,
    });
    this.restartedAt = null;
    return { badDeployId: this.badId };
  }

  get badDeploy(): Deploy | null {
    return this.deploys.find((d) => d.id === this.badId) ?? null;
  }

  // When the current outage began (or the start of the simulation if healthy).
  get impactAt(): number {
    return this.badDeploy?.at ?? this.startedAt;
  }

  get fixedAt(): number | null {
    return this.badDeploy?.rolledBackAt ?? null;
  }

  // An outage that hasn't been fixed yet.
  get broken(): boolean {
    return !!this.badDeploy && this.fixedAt === null;
  }

  private cdnChangeAt(): number | null {
    return this.deploys.find((d) => d.id === this.cdnId)?.at ?? null;
  }

  // 0 = healthy, 1 = full outage, for the payments path at time t.
  private severity(t: number): number {
    if (!this.badDeploy || t < this.impactAt) return 0;
    const ramp = Math.min(1, (t - this.impactAt) / (1.5 * MIN));
    const fixed = this.fixedAt;
    if (fixed !== null && t >= fixed) return ramp * Math.max(0, 1 - (t - fixed) / (0.75 * MIN)); // recovers over ~45s
    if (this.restartedAt !== null && t >= this.restartedAt && t < this.restartedAt + 40_000) {
      return ramp * Math.min(1, 0.25 + (t - this.restartedAt) / 40_000); // brief relief, then back
    }
    return ramp;
  }

  metric(service: Service, metric: Metric, t: number): number {
    const s = this.severity(t);
    const noise = (seed: number) => Math.sin(t / 7000 + seed) * 0.5 + Math.sin(t / 2300 + seed * 3) * 0.5; // -1..1, deterministic
    switch (`${service}:${metric}`) {
      case "checkout-api:error_rate":
        return Math.max(0, 0.4 + s * 37 + noise(1) * (0.15 + s * 2)); // %
      case "checkout-api:p95_latency_ms":
        return 180 + s * 4800 + noise(2) * 20;
      case "payments-api:error_rate":
        return Math.max(0, 0.2 + s * 41 + noise(3) * (0.1 + s * 2));
      case "payments-api:p95_latency_ms":
        return 120 + s * 5100 + noise(4) * 15;
      case "payments-api:db_pool_in_use": {
        const max = !this.badDeploy || (this.fixedAt !== null && t >= this.fixedAt) ? 50 : t >= this.impactAt ? 5 : 50;
        return max === 5 ? Math.min(5, 1 + s * 4 + Math.abs(noise(5))) : 9 + noise(5) * 3;
      }
      case "web-frontend:error_rate":
        return Math.max(0, 0.1 + s * 3 + noise(6) * 0.05);
      case "search-api:error_rate":
        return 1.2 + noise(7) * 0.2; // elevated since #479, unrelated
      case "search-api:p95_latency_ms":
        return t >= this.deploys[0]!.at ? 790 + noise(8) * 40 : 310;
      case "cdn:cache_hit_ratio": {
        const cdnChange = this.cdnChangeAt();
        if (cdnChange === null || t < cdnChange) return 96 + noise(9);
        return Math.min(96, 61 + ((t - cdnChange) / (8 * MIN)) * 35) + noise(9); // dips, then refills
      }
      case "checkout-api:rps":
        return 340 - s * 120 + noise(10) * 15;
      default:
        return metric === "error_rate" ? 0.1 + Math.abs(noise(11)) * 0.1 : metric === "p95_latency_ms" ? 150 + noise(12) * 10 : 0;
    }
  }

  series(service: Service, metric: Metric, minutes: number, now = Date.now()): { t: number; v: number }[] {
    const points: { t: number; v: number }[] = [];
    for (let t = now - minutes * MIN; t <= now; t += Math.max(5000, (minutes * MIN) / 60)) points.push({ t, v: this.metric(service, metric, t) });
    return points;
  }

  logs(service: Service, sinceMinutes: number, contains: string | undefined, now = Date.now()): string[] {
    const lines: string[] = [];
    const from = now - sinceMinutes * MIN;
    const step = 9000;
    let i = 0;
    for (let t = from; t <= now; t += step, i++) {
      const s = this.severity(t);
      const ts = new Date(t).toISOString();
      const line = this.logLine(service, s, i, t);
      if (line) lines.push(`${ts} ${line}`);
    }
    const filtered = contains ? lines.filter((l) => l.toLowerCase().includes(contains.toLowerCase())) : lines;
    return filtered.slice(-80);
  }

  private logLine(service: Service, s: number, i: number, t: number): string | null {
    const id = (n: number) => (Math.abs(Math.sin(i * 12.9898 + n) * 43758.5453) % 1).toString(36).slice(2, 10);
    const pool = !this.badDeploy || (this.fixedAt !== null && t >= this.fixedAt) ? 50 : t >= this.impactAt ? 5 : 50;
    switch (service) {
      case "payments-api":
        if (s > 0.3)
          return i % 3 === 0
            ? `ERROR db: timeout acquiring connection from pool (max=${pool}, in_use=${pool}, waiting=${Math.round(80 + s * 140)}) charge=ch_${id(1)}`
            : i % 3 === 1
              ? `WARN retry ${2 + (i % 5)}/6 for charge=ch_${id(2)} after pool timeout`
              : `ERROR POST /v1/charges 503 ${Math.round(4000 + s * 1100)}ms`;
        return i % 4 === 0 ? `INFO POST /v1/charges 200 ${110 + (i % 30)}ms pool=${pool}` : null;
      case "checkout-api":
        if (s > 0.3) return i % 2 === 0 ? `ERROR upstream payments-api POST /v1/charges 504 after 5000ms order=or_${id(3)}` : `WARN circuit half-open for payments-api`;
        return i % 5 === 0 ? `INFO POST /checkout 200 ${160 + (i % 40)}ms` : null;
      case "web-frontend":
        if (s > 0.3 && i % 3 === 0) return `WARN checkout request failed status=502 route=/checkout`;
        return i % 6 === 0 ? `INFO GET / 200 ${40 + (i % 20)}ms` : null;
      case "search-api":
        return i % 4 === 0 ? `WARN slow query ranking=v7 took ${760 + (i % 90)}ms` : null;
      case "cdn": {
        const cdnChange = this.cdnChangeAt();
        if (cdnChange !== null && t >= cdnChange && i % 2 === 0) return `MISS /static/app.${id(4).slice(0, 6)}.js origin_fetch=${120 + (i % 60)}ms`;
        return i % 5 === 0 ? `HIT /static/app.js` : null;
      }
    }
  }

  rollback(deployId: string, now = Date.now()): string {
    const d = this.deploys.find((x) => x.id === deployId);
    if (!d) return `No deploy #${deployId}.`;
    if (d.rolledBackAt) return `Deploy #${deployId} was already rolled back.`;
    d.rolledBackAt = now;
    this.deploys.push({
      id: String(Math.max(...this.deploys.map((x) => Number(x.id))) + 1),
      service: d.service,
      author: "control-tower",
      at: now,
      message: `Revert #${d.id}: ${d.message}`,
      diff: d.diff
        .split("\n")
        .map((l) => (l.startsWith("+ ") ? `- ${l.slice(2)}` : l.startsWith("- ") ? `+ ${l.slice(2)}` : l))
        .join("\n"),
      rolledBackAt: null,
    });
    return `Rolled back #${d.id} on ${d.service}. Rollout complete in 20s.`;
  }

  restart(service: Service, now = Date.now()): string {
    if (service === "payments-api") this.restartedAt = now;
    return `Restarted ${service}: 6/6 pods ready.`;
  }

  postStatus(status: string, message: string, now = Date.now()): string {
    this.statusPosts.push({ at: now, status, message });
    return `Posted to status.shopfront.example: [${status}] ${message}`;
  }
}
