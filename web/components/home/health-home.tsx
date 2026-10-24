import { useState } from "react";
import { ArrowRight, CheckCircle2, Eye, EyeOff, Siren, Zap } from "lucide-react";
import type { WatchView } from "../../../server/types.ts";
import { Button } from "@/components/ui/button";
import { TaskStatusIcon, TaskStatusLabel } from "@/components/tasks/task-status";
import { useTasks } from "@/hooks/use-tasks";
import { formatDuration } from "@/lib/spans";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

// Home: production's health. Calm when all is well, so the moment the tower
// speaks up stands out.
export function HealthHome() {
  const watch = useTower((s) => s.watch);
  const incident = useTower((s) => s.incident);
  const send = useTower((s) => s.send);
  const connected = useTower((s) => s.connected);
  const setShowIncident = useTower((s) => s.setShowIncident);
  const setFocus = useTower((s) => s.setFocus);
  const followUps = useTasks().filter((t) => t.followUp);
  const bad = watch?.state === "anomaly";
  const off = watch && !watch.enabled;

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-6 overflow-y-auto rounded-xl bg-card px-6 py-10 ring-1 ring-foreground/10">
      <section
        className={cn(
          "flex w-full max-w-3xl flex-col gap-6 rounded-2xl p-8 ring-1",
          bad ? "bg-span-error/5 ring-span-error/40" : "bg-background ring-foreground/10",
        )}
        aria-live="polite"
      >
        <div className="flex items-start gap-4">
          <span className={cn("grid size-12 shrink-0 place-items-center rounded-xl", bad ? "bg-span-error text-white" : off ? "bg-secondary" : "bg-span-tool/15 text-span-tool")}>
            {bad ? <Siren className="size-6" /> : off ? <EyeOff className="size-6" /> : <CheckCircle2 className="size-6" />}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-3xl leading-tight">{!watch ? "Connecting…" : off ? "Not watching" : bad ? "Something’s wrong" : "All good"}</h1>
            <p className="mt-1 text-[15px] text-muted-foreground">
              {off
                ? "Turn watching back on and the tower will check production every 5 seconds."
                : bad
                  ? "Checkout errors are above normal. The tower is on it."
                  : "Watching checkout on Shopfront every 5 seconds. The tower will speak up if something breaks."}
            </p>
          </div>
        </div>
        {watch && <HealthChart watch={watch} />}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" disabled={!connected} onClick={() => send({ type: "watch_toggle", on: !watch?.enabled })}>
            {watch?.enabled ? <EyeOff data-icon="inline-start" /> : <Eye data-icon="inline-start" />}
            {watch?.enabled ? "Stop watching" : "Watch production"}
          </Button>
          <Button variant="ghost" size="sm" disabled={!connected || bad} onClick={() => send({ type: "simulate_outage" })} title="Lands a bad deploy on the simulated store">
            <Zap data-icon="inline-start" /> Simulate a bad deploy
          </Button>
        </div>
      </section>

      {incident && (
        <section className="w-full max-w-3xl">
          <h2 className="mb-2 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">{incident.status === "resolved" ? "Last incident" : "Open incident"}</h2>
          <button
            onClick={() => setShowIncident(true)}
            className="flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left ring-1 ring-foreground/10 transition-colors hover:bg-accent"
          >
            <Siren className={cn("size-4 shrink-0", incident.status === "resolved" ? "text-muted-foreground" : "text-span-error")} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-medium">{incident.title}</span>
              <span className="text-[12.5px] text-muted-foreground">
                {incident.status === "resolved" ? "Resolved" : "In progress"} · {incident.findings.length} findings
                {incident.mitigatedAt ? ` · customers affected for ${formatDuration(incident.mitigatedAt - incident.impactAt)}` : ""}
              </span>
            </span>
            <ArrowRight className="size-4 text-muted-foreground" />
          </button>
        </section>
      )}

      {followUps.length > 0 && (
        <section className="w-full max-w-3xl">
          <h2 className="mb-2 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">Follow-ups from the review</h2>
          <ul className="flex flex-col divide-y divide-border rounded-xl ring-1 ring-foreground/10">
            {followUps.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => setFocus(t.resultAgentId ?? t.agentIds[0] ?? null)}
                  disabled={!t.agentIds.length}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-accent"
                >
                  <TaskStatusIcon status={t.status} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-[14px]">{t.title}</span>
                  <span className="text-[12.5px] text-muted-foreground">
                    <TaskStatusLabel status={t.status} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// The last 10 minutes of checkout errors, with the threshold the tower acts on.
function HealthChart({ watch }: { watch: WatchView }) {
  const [hover, setHover] = useState<number | null>(null);
  const pts = watch.series;
  if (pts.length < 2) return null;
  const W = 640;
  const H = 120;
  const max = Math.max(10, ...pts.map((p) => p.v));
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => H - 4 - (v / max) * (H - 12);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const bad = watch.state === "anomaly";
  const h = hover !== null ? pts[hover] : null;
  return (
    <div className="flex items-end gap-6">
      <div className="shrink-0">
        <p className="font-heading text-5xl leading-none tabular-nums">{watch.errorRate.toFixed(1)}%</p>
        <p className="mt-1.5 text-[13px] text-muted-foreground">checkout errors now</p>
      </div>
      <div className="relative min-w-0 flex-1">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="h-[120px] w-full overflow-visible"
          preserveAspectRatio="none"
          role="img"
          aria-label={`Checkout error rate over the last 10 minutes, now ${watch.errorRate.toFixed(1)}%`}
          onMouseMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHover(Math.round(((e.clientX - r.left) / r.width) * (pts.length - 1)));
          }}
          onMouseLeave={() => setHover(null)}
        >
          <line x1={0} x2={W} y1={y(watch.thresholdPct)} y2={y(watch.thresholdPct)} className="stroke-foreground/25" strokeDasharray="4 4" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <path d={d} fill="none" className={bad ? "stroke-span-error" : "stroke-span-tool"} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
          {h && <line x1={x(hover!)} x2={x(hover!)} y1={0} y2={H} className="stroke-foreground/30" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
        </svg>
        <span className="absolute right-0 font-mono text-[11px] text-muted-foreground" style={{ top: `${(y(watch.thresholdPct) / H) * 100}%`, transform: "translateY(-120%)" }}>
          acts above {watch.thresholdPct}%
        </span>
        {h && (
          <span className="pointer-events-none absolute -top-7 left-0 rounded-md border border-border bg-popover px-2 py-0.5 font-mono text-[11px] shadow-sm" style={{ left: `calc(${(hover! / (pts.length - 1)) * 100}% - 48px)` }}>
            {new Date(h.t).toLocaleTimeString()} · {h.v.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}
