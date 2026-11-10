import { SimulatorSource } from "./simulator.ts";
import type { ProductionSource } from "./source.ts";

export type { ProductionSource } from "./source.ts";

// PRODUCTION_SOURCE picks the backend. Only the simulator ships today; the
// Prometheus/Loki + GitHub stack is next (docs/ROADMAP.md, phase 2).
export function createProductionSource(kind = process.env.PRODUCTION_SOURCE || "simulator"): ProductionSource {
  switch (kind) {
    case "simulator":
      return new SimulatorSource();
    default:
      throw new Error(`Unknown PRODUCTION_SOURCE "${kind}". Supported: simulator.`);
  }
}
