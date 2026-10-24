// Checks the outage simulator's story without running agents.
import { ShopfrontSim } from "../server/incident/sim.ts";

const now = Date.now();
const sim = new ShopfrontSim(now);
const at = (min: number) => now + min * 60_000;
const row = (label: string, t: number) =>
  console.log(
    label.padEnd(26),
    `checkout err ${sim.metric("checkout-api", "error_rate", t).toFixed(1).padStart(5)}%`,
    `payments p95 ${sim.metric("payments-api", "p95_latency_ms", t).toFixed(0).padStart(5)}ms`,
    `pool ${sim.metric("payments-api", "db_pool_in_use", t).toFixed(1).padStart(4)}`,
    `cdn hit ${sim.metric("cdn", "cache_hit_ratio", t).toFixed(0)}%`,
  );

row("before deploy (-12m)", at(-12));
row("incident declared (0m)", at(0));
console.log(sim.logs("payments-api", 1, "pool", at(0)).slice(-1)[0]);
sim.restart("payments-api", at(1));
row("10s after restart", at(1) + 10_000);
row("60s after restart", at(2));
console.log(sim.rollback("482", at(3)));
row("20s after rollback", at(3) + 20_000);
row("60s after rollback", at(4));
console.log(sim.logs("payments-api", 1, undefined, at(4)).slice(-1)[0]);
