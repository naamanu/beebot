import type { Deploy, ShopfrontSim } from "../incident/sim.ts";
import type { WatchView } from "../types.ts";

export interface Anomaly {
  errorRate: number; // checkout error rate, %, when it was confirmed
  since: number; // first breaching sample
  suspect: Deploy | null; // the most recent deploy shortly before the spike
}

export interface WatchOptions {
  thresholdPct?: number; // checkout error rate that counts as a breach
  sustain?: number; // consecutive breaching checks before it acts
  suspectWindowMs?: number; // how far before the spike a deploy is a suspect
}

// Watches production without being asked. A sustained breach of the checkout
// error rate is an anomaly; it fires once, then re-arms only after the store
// has been healthy again.
export class Watchtower {
  enabled = true;
  private breaches: number[] = []; // timestamps of consecutive breaching checks
  private armed = true;
  private lastCheck = 0;
  private lastRate = 0;
  private readonly threshold: number;
  private readonly sustain: number;
  private readonly suspectWindow: number;

  constructor(
    private sim: ShopfrontSim,
    private onAnomaly: (a: Anomaly) => void,
    opts: WatchOptions = {},
  ) {
    this.threshold = opts.thresholdPct ?? 5;
    this.sustain = opts.sustain ?? 2;
    this.suspectWindow = opts.suspectWindowMs ?? 15 * 60_000;
  }

  // One look at production. Returns the anomaly if this check confirmed one.
  check(now = Date.now()): Anomaly | null {
    this.lastCheck = now;
    this.lastRate = this.sim.metric("checkout-api", "error_rate", now);
    if (this.lastRate < this.threshold) {
      this.breaches = [];
      this.armed = true;
      return null;
    }
    this.breaches.push(now);
    if (!this.enabled || !this.armed || this.breaches.length < this.sustain) return null;
    this.armed = false;
    const since = this.breaches[0]!;
    const suspect =
      [...this.sim.deploys]
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

  view(now = Date.now()): WatchView {
    const breaching = this.lastRate >= this.threshold;
    return {
      enabled: this.enabled,
      errorRate: Math.round(this.lastRate * 10) / 10,
      state: breaching ? "anomaly" : "healthy",
      thresholdPct: this.threshold,
      lastCheckAt: this.lastCheck,
      series: this.sim.series("checkout-api", "error_rate", 10, now).map((p) => ({ t: p.t, v: Math.round(p.v * 10) / 10 })),
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
