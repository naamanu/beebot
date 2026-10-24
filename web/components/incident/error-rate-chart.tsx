import { useState } from "react";
import type { IncidentView } from "../../../server/types.ts";

// Checkout error rate, last 15 minutes. One series, 2px line, hover crosshair,
// with production actions (rollbacks, restarts) marked where they happened.
export function ErrorRateChart({ incident }: { incident: IncidentView }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = incident.errorRate;
  if (pts.length < 2) return null;
  const W = 320;
  const H = 56;
  const t0 = pts[0]!.t;
  const t1 = pts.at(-1)!.t;
  const max = Math.max(40, ...pts.map((p) => p.v));
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W;
  const y = (v: number) => H - 2 - (v / max) * (H - 6);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const actions = incident.timeline.filter((e) => e.kind === "action" && e.at >= t0 && /Rolled back|Restarted/.test(e.text));
  const h = hover !== null ? pts[hover] : null;
  const current = pts.at(-1)!.v;

  return (
    <div className="flex items-center gap-3">
      <div className="text-right">
        <p className="font-heading text-2xl leading-none tabular-nums">{current.toFixed(1)}%</p>
        <p className="mt-1 text-[11px] text-muted-foreground">checkout errors</p>
      </div>
      <div className="relative">
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          className="overflow-visible"
          role="img"
          aria-label={`Checkout error rate over the last 15 minutes, now ${current.toFixed(1)}%`}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const t = t0 + ((e.clientX - r.left) / r.width) * (t1 - t0);
            let best = 0;
            pts.forEach((p, i) => Math.abs(p.t - t) < Math.abs(pts[best]!.t - t) && (best = i));
            setHover(best);
          }}
          onMouseLeave={() => setHover(null)}
        >
          <line x1={0} x2={W} y1={y(0)} y2={y(0)} className="stroke-border" strokeWidth={1} />
          {actions.map((a) => (
            <g key={a.at}>
              <line x1={x(a.at)} x2={x(a.at)} y1={0} y2={H} className="stroke-span-tool" strokeWidth={1} strokeDasharray="3 3" />
            </g>
          ))}
          <path d={d} fill="none" className="stroke-span-agent" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {h && (
            <>
              <line x1={x(h.t)} x2={x(h.t)} y1={0} y2={H} className="stroke-foreground/30" strokeWidth={1} />
              <circle cx={x(h.t)} cy={y(h.v)} r={4} className="fill-span-agent stroke-card" strokeWidth={2} />
            </>
          )}
        </svg>
        {h && (
          <div
            className="pointer-events-none absolute -top-9 z-10 rounded-md border border-border bg-popover px-2 py-1 font-mono text-[11px] whitespace-nowrap shadow-sm"
            style={{ left: Math.min(Math.max(x(h.t) - 50, 0), W - 100) }}
          >
            {new Date(h.t).toLocaleTimeString()} · {h.v.toFixed(1)}%
          </div>
        )}
        {actions.length > 0 && (
          <span className="absolute -bottom-4 font-mono text-[10px] text-span-tool" style={{ left: Math.max(0, x(actions.at(-1)!.at) - 20) }}>
            {/Rolled back/.test(actions.at(-1)!.text) ? "rollback" : "restart"}
          </span>
        )}
      </div>
    </div>
  );
}
