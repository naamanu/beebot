import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Maximize2, Waypoints } from "lucide-react";
import type { AgentEvent, AgentView } from "../../server/types.ts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Dot, Pill } from "@/components/pill";
import { useNow } from "@/hooks/use-now";
import { navigate } from "@/hooks/use-route";
import { EVENT_STYLE, STATUS_STYLE, formatDuration, splitTool } from "@/lib/spans";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

export function AgentCard({ agent }: { agent: AgentView }) {
  const steeredAt = useTower((s) => s.steeredAt[agent.id] ?? 0);
  const setFocus = useTower((s) => s.setFocus);
  const live = agent.status === "working" || agent.status === "starting";
  const now = useNow(1000, live);
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!steeredAt) return;
    setFlashing(true);
    const t = setTimeout(() => setFlashing(false), 1600);
    return () => clearTimeout(t);
  }, [steeredAt]);

  const first = agent.events[0]?.at;
  const last = agent.events.at(-1)?.at ?? first;
  const elapsed = first ? (live ? now : (last ?? now)) - first : 0;
  const tools = agent.events.filter((e) => e.kind === "tool").length;
  const status = STATUS_STYLE[agent.status];

  return (
    <Card
      onDoubleClick={() => setFocus(agent.id)}
      className={cn(
        "relative min-h-0 gap-0 py-0 transition-shadow duration-300",
        flashing && "ring-2 ring-span-http shadow-[0_0_0_6px] shadow-span-http/15",
        agent.status === "paused" && "opacity-80",
      )}
    >
      <div className="@container flex flex-col gap-2.5 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-md bg-secondary font-heading text-sm">{agent.id}</span>
          <h2 className="font-mono text-sm font-medium whitespace-nowrap">agent-{agent.id}</h2>
          <div className="ml-auto flex items-center gap-1.5">
            <Pill className={status.className}>
              <Dot className={status.dot} />
              {status.label}
            </Pill>
            <Pill>{formatDuration(elapsed)}</Pill>
            <Pill className="hidden @[24rem]:inline-flex">${agent.costUsd.toFixed(4)}</Pill>
            <Pill className="hidden @[36rem]:inline-flex">{tools} tools</Pill>
            {agent.runId && (
              <Button variant="ghost" size="icon-sm" onClick={() => navigate(`/runs/${agent.runId}`)} aria-label={`Trace of agent ${agent.id}'s current run`} title="View trace">
                <Waypoints />
              </Button>
            )}
            <Button variant="ghost" size="icon-sm" onClick={() => setFocus(agent.id)} aria-label={`Open agent ${agent.id}`}>
              <Maximize2 />
            </Button>
          </div>
        </div>
        <p className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">{agent.task}</p>
      </div>
      <SpanList events={agent.events} />
    </Card>
  );
}

function SpanList({ events }: { events: AgentEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);

  const start = events[0]?.at ?? 0;
  const span = Math.max((events.at(-1)?.at ?? start) - start, 1);

  if (events.length === 0) {
    return (
      <div className="flex flex-1 items-center gap-2 px-4 font-mono text-xs text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
        booting agent…
      </div>
    );
  }

  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto py-1.5 [scrollbar-width:thin]">
      <AnimatePresence initial={false}>
        {events.map((e, i) => (
          <motion.div
            key={`${e.at}-${i}`}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
          >
            <SpanRow event={e} offset={(e.at - start) / span} relMs={e.at - start} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function SpanRow({ event, offset, relMs }: { event: AgentEvent; offset: number; relMs: number }) {
  const style = EVENT_STYLE[event.kind];
  const { name, detail } = event.kind === "tool" ? splitTool(event.text) : { name: style.label, detail: event.text };
  const emphasized = event.kind === "steer" || event.kind === "result" || event.kind === "error";

  return (
    <HoverCard openDelay={350} closeDelay={50}>
      <HoverCardTrigger asChild>
        <div
          className={cn(
            "group grid cursor-default grid-cols-[minmax(0,1fr)_88px_52px] items-center gap-3 px-4 py-[5px] hover:bg-accent",
            event.kind === "steer" && "bg-span-http/8",
          )}
        >
          <div className="flex min-w-0 items-center gap-2">
            <Dot className={style.dot} />
            <span className={cn("shrink-0 text-[13px] font-semibold", emphasized && kindText(event.kind))}>{name}</span>
            <span className="truncate font-mono text-[11.5px] text-muted-foreground">{detail}</span>
          </div>
          {/* Position on the agent's timeline */}
          <div className="relative h-2 rounded-full bg-muted">
            <span
              className={cn("absolute top-0 h-2 w-2.5 rounded-full", style.bar)}
              style={{ left: `calc(${Math.min(offset, 1) * 100}% - ${Math.min(offset, 1) * 10}px)` }}
            />
          </div>
          <span className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
            +{formatDuration(relMs)}
          </span>
        </div>
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-96 font-mono text-xs">
        <div className="mb-1.5 flex items-center gap-2 font-sans text-sm font-semibold">
          <Dot className={style.dot} />
          {name}
        </div>
        <p className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">{event.text}</p>
        <p className="mt-2 text-[11px] text-muted-foreground/70">{new Date(event.at).toLocaleTimeString()}</p>
      </HoverCardContent>
    </HoverCard>
  );
}

function kindText(kind: AgentEvent["kind"]): string {
  return kind === "steer" ? "text-span-http" : kind === "result" ? "text-span-workflow" : "text-span-error";
}
