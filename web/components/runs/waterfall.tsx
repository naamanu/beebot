import { XCircle } from "lucide-react";
import type { SpanRow } from "../../../server/types.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dot } from "@/components/pill";
import { formatCost, formatTokens } from "@/lib/format";
import { SPAN_KIND_STYLE, formatDuration } from "@/lib/spans";
import { cn } from "@/lib/utils";

// A trace waterfall: one row per span, bars placed on the run's timeline.
export function Waterfall({
  spans,
  start,
  end,
  selected,
  onSelect,
}: {
  spans: SpanRow[];
  start: number;
  end: number;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const total = Math.max(end - start, 1);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const pos = (t: number) => ((t - start) / total) * 100;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Legend + time axis */}
      <div className="grid shrink-0 grid-cols-[minmax(240px,38%)_minmax(0,1fr)] border-b border-border">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[11px] text-muted-foreground">
          {Object.entries(SPAN_KIND_STYLE).map(([kind, s]) => (
            <span key={kind} className="flex items-center gap-1.5">
              <Dot className={s.dot} />
              {s.label}
            </span>
          ))}
        </div>
        <div className="relative mr-16 ml-3 h-full">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute top-1/2 -translate-y-1/2 font-mono text-[10.5px] text-muted-foreground tabular-nums"
              style={{ left: `${t * 100}%`, transform: `translate(${t === 1 ? "-100%" : t === 0 ? "0" : "-50%"}, -50%)` }}
            >
              {formatDuration(t * total)}
            </span>
          ))}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
        {/* Recessive gridlines behind the bars */}
        <div className="pointer-events-none absolute inset-y-0 right-16 left-[calc(max(240px,38%)+0.75rem)]">
          {ticks.map((t) => (
            <div key={t} className="absolute inset-y-0 border-l border-dashed border-border" style={{ left: `${t * 100}%` }} />
          ))}
        </div>

        {spans.map((s) => {
          const style = SPAN_KIND_STYLE[s.kind];
          const spanEnd = s.endedAt ?? end;
          const dur = spanEnd - s.startedAt;
          const isPoint = s.kind === "operator" || dur === 0;
          const left = pos(s.startedAt);
          const width = Math.max(pos(spanEnd) - left, 0.4);
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={cn(
                "relative grid w-full grid-cols-[minmax(240px,38%)_minmax(0,1fr)] items-center text-left hover:bg-accent",
                selected === s.id && "bg-secondary hover:bg-secondary",
              )}
            >
              <span className={cn("flex min-w-0 items-center gap-2 py-[7px] pr-3", s.kind === "invoke_agent" ? "pl-4" : "pl-8")}>
                <Dot className={style.dot} />
                <span className="shrink-0 text-[13px] font-semibold">{s.name}</span>
                <span className="truncate font-mono text-[11.5px] text-muted-foreground">{s.detail}</span>
                {s.status === "error" && (
                  <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] font-medium text-span-error">
                    <XCircle className="size-3.5" /> error
                  </span>
                )}
              </span>
              <span className="relative mr-16 ml-3 h-6">
                <Tooltip>
                  <TooltipTrigger asChild>
                    {isPoint ? (
                      <span
                        className={cn("absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] ring-2 ring-card", style.bar)}
                        style={{ left: `${left}%` }}
                      />
                    ) : (
                      <span
                        className={cn("absolute top-1/2 h-3.5 -translate-y-1/2 rounded-[4px]", style.bar, !s.endedAt && "animate-pulse")}
                        style={{ left: `${left}%`, width: `${width}%` }}
                      />
                    )}
                  </TooltipTrigger>
                  <TooltipContent className="font-mono text-xs">
                    <SpanTip span={s} dur={dur} />
                  </TooltipContent>
                </Tooltip>
                {!isPoint && (
                  <span
                    className="absolute top-1/2 -translate-y-1/2 pl-1.5 font-mono text-[11px] whitespace-nowrap text-muted-foreground tabular-nums"
                    style={{ left: `${left + width}%` }}
                  >
                    {formatDuration(dur)}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SpanTip({ span, dur }: { span: SpanRow; dur: number }) {
  const a = span.attrs as Record<string, number | string | undefined>;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="flex items-center gap-2 font-sans font-semibold">
        <Dot className={SPAN_KIND_STYLE[span.kind].dot} />
        {span.name}
      </span>
      {span.kind === "chat" && <span>{String(a.model)}</span>}
      <span>
        {formatDuration(dur)}
        {typeof a.costUsd === "number" && ` · ${formatCost(a.costUsd)}`}
      </span>
      {typeof a.inputTokens === "number" && (
        <span className="opacity-70">
          {formatTokens(a.inputTokens + Number(a.cacheReadTokens ?? 0))} input tok
          {typeof a.outputTokens === "number" && ` → ${formatTokens(a.outputTokens)}`}
        </span>
      )}
    </div>
  );
}
