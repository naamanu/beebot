import { useState } from "react";
import type { RunRow } from "../../../server/types.ts";
import { navigate } from "@/hooks/use-route";
import { formatCost } from "@/lib/format";
import { formatDuration } from "@/lib/spans";
import { cn } from "@/lib/utils";
import { RunStatusPill } from "./run-status";

// Spend per run, oldest → newest. One series, one hue; hover for details,
// click to open the run.
export function CostChart({ runs }: { runs: RunRow[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const data = [...runs].slice(0, 48).reverse();
  const max = niceMax(Math.max(...data.map((r) => r.costUsd), 0.001));
  const ticks = [max, max / 2, 0];
  const h = hover !== null ? data[hover] : null;

  if (data.length === 0) {
    return <p className="grid h-full place-items-center text-sm text-muted-foreground">No runs yet.</p>;
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="relative flex min-h-0 flex-1">
        {/* Recessive y axis: three labelled gridlines */}
        <div className="flex w-14 shrink-0 flex-col justify-between pr-2 text-right font-mono text-[10.5px] text-muted-foreground tabular-nums">
          {ticks.map((t) => (
            <span key={t} className="-translate-y-1/2 first:translate-y-0 last:translate-y-0">
              {formatCost(t)}
            </span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          {ticks.map((t, i) => (
            <div key={t} className="absolute inset-x-0 border-t border-dashed border-border" style={{ top: `${(i / (ticks.length - 1)) * 100}%` }} />
          ))}
          <div className="absolute inset-0 flex items-end gap-[2px]" onMouseLeave={() => setHover(null)}>
            {data.map((r, i) => (
              <button
                key={r.id}
                aria-label={`${r.task}: ${formatCost(r.costUsd)}`}
                onMouseEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onClick={() => navigate(`/runs/${r.id}`)}
                className="group flex h-full max-w-7 min-w-0 flex-1 cursor-pointer items-end"
              >
                <span
                  className={cn(
                    "block w-full rounded-t-[4px] bg-span-workflow transition-opacity",
                    r.status === "running" && "opacity-50",
                    hover !== null && hover !== i && "opacity-40",
                  )}
                  style={{ height: `max(2px, ${(r.costUsd / max) * 100}%)` }}
                />
              </button>
            ))}
          </div>
        </div>
      </div>

      {h && (
        <div
          className="pointer-events-none absolute top-0 z-10 w-64 rounded-lg border border-border bg-popover p-3 text-xs shadow-md"
          style={{ left: `clamp(0px, calc(3.5rem + ${((hover! + 0.5) / data.length) * 100}% - 8rem), calc(100% - 16rem))` }}
        >
          <p className="mb-2 line-clamp-2 font-medium">{h.task}</p>
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
            <RunStatusPill status={h.status} className="h-5 px-2 text-[10px]" />
            <span>{formatCost(h.costUsd)}</span>
            <span className="text-muted-foreground">·</span>
            <span>{h.endedAt ? formatDuration(h.endedAt - h.startedAt) : "running"}</span>
            <span className="text-muted-foreground">· agent-{h.agentId}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function niceMax(x: number): number {
  const exp = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * exp >= x) return m * exp;
  return 10 * exp;
}
