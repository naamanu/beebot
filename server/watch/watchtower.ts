import type { Deploy, Point, ProductionSource } from "../production/source.ts";
import type { WatchView } from "../types.ts";

export interface Anomaly {
  errorRate: number; // the health signal (e.g. checkout error rate, %) when it was confirmed
  since: number; // first breaching sample
  suspect: Deploy | null; // the most recent deploy shortly before the spike
}

export interface WatchOptions {
  thresholdPct?: number; // overrides the source's health threshold
  sustain?: number; // consecutive breaching checks before it acts
  suspectWindowMs?: number; // how far before the spike a deploy is a suspect
}

// Watches production without being asked. A sustained breach of the source's
// health signal is an anomaly; it fires once, then re-arms only after
// production has been healthy again.
export class Watchtower {
  enabled = true;
  private breaches: number[] = []; // timestamps of consecutive breaching checks
  private armed = true;
  private lastCheck = 0;
  private lastRate = 0;
  private lastSeries: Point[] = [];
  private lastError: string | null = null;
  private readonly threshold: number;
  private readonly sustain: number;
  private readonly suspectWindow: number;

  constructor(
    private source: ProductionSource,
    private onAnomaly: (a: Anomaly) => void,
    opts: WatchOptions = {},
  ) {
    this.threshold = opts.thresholdPct ?? source.health.thresholdPct;
    this.sustain = opts.sustain ?? 2;
    this.suspectWindow = opts.suspectWindowMs ?? 15 * 60_000;
  }

  // One look at production. Returns the anomaly if this check confirmed one.
  // A backend error counts as no data: it neither breaches nor re-arms.
  async check(now = Date.now()): Promise<Anomaly | null> {
    const { service, metric } = this.source.health;
    let series: Point[];
    try {
      series = await this.source.series(service, metric, 10, now);
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message;
      this.lastCheck = now;
      return null;
    }
    const latest = series.at(-1);
    this.lastCheck = now;
    this.lastSeries = series.map((p) => ({ t: p.t, v: Math.round(p.v * 10) / 10 }));
    if (!latest) return null;
    this.lastRate = latest.v;
    if (this.lastRate < this.threshold) {
      this.breaches = [];
      this.armed = true;
      return null;
    }
    this.breaches.push(now);
    if (!this.enabled || !this.armed || this.breaches.length < this.sustain) return null;
    this.armed = false;
    const since = this.breaches[0]!;
    const deploys = await this.source.deploys(now).catch(() => [] as Deploy[]);
    const suspect =
      deploys
        .filter((d) => d.at <= since && since - d.at <= this.suspectWindow && !d.rolledBackAt)
        .sort((a, b) => b.at - a.at)[0] ?? null;
    const anomaly = { errorRate: this.lastRate, since, suspect };
    this.onAnomaly(anomaly);
    return anomaly;
  }

  // Don't act on the current breach again (e.g. the operator stood down).
  disarm(): void {
    this.armed = false;
  }

  view(): WatchView {
    const breaching = this.lastRate >= this.threshold;
    return {
      enabled: this.enabled,
      errorRate: Math.round(this.lastRate * 10) / 10,
      state: breaching ? "anomaly" : "healthy",
      thresholdPct: this.threshold,
      lastCheckAt: this.lastCheck,
      series: this.lastSeries,
      source: { id: this.source.id, label: this.source.label, simulated: this.source.simulated, demo: !!this.source.demo },
      healthLabel: this.source.health.label,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }
}

// "12 seconds", "1 minute", "4 minutes": how long after the deploy.
function ago(ms: number): string {
  if (ms < 60_000) {
    const s = Math.max(1, Math.round(ms / 1000));
    return `${s} second${s === 1 ? "" : "s"}`;
  }
  const m = Math.round(ms / 60_000);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

const clock = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

// What the tower says when it acts on its own.
export function anomalyBriefing(a: Anomaly): string {
  const rate = `${Math.round(a.errorRate)} percent`;
  const cause = a.suspect ? `, ${ago(a.since - a.suspect.at)} after deploy ${a.suspect.id} to ${a.suspect.service} by ${a.suspect.author}` : "";
  return `Heads up: checkout errors jumped to ${rate} at ${clock(a.since)}${cause}. I've started four investigators. Say “stand down” to cancel.`;
}
