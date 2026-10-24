import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Maximize2 } from "lucide-react";
import type { AgentView } from "../../../server/types.ts";
import { Button } from "@/components/ui/button";
import { Dot } from "@/components/pill";
import { ApprovalCard } from "@/components/incident/approval-card";
import { useNow } from "@/hooks/use-now";
import { EVENT_STYLE, STATUS_STYLE, agentName, currentAction, formatDuration, splitTool } from "@/lib/spans";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

// One agent's live stream in the tower: who it is, what it's doing now, and
// its recent activity scrolling by. Glows when you steer it.
export function LiveAgentCard({ agent }: { agent: AgentView }) {
  const setFocus = useTower((s) => s.setFocus);
  const send = useTower((s) => s.send);
  const steeredAt = useTower((s) => s.steeredAt[agent.id] ?? 0);
  const focused = useTower((s) => s.focused === agent.id);
  const live = agent.status === "working" || agent.status === "starting" || !!agent.startsAt;
  const now = useNow(1000, live);
  const [glow, setGlow] = useState(false);
  useEffect(() => {
    if (!steeredAt) return;
    setGlow(true);
    const t = setTimeout(() => setGlow(false), 1800);
    return () => clearTimeout(t);
  }, [steeredAt]);

  const status = STATUS_STYLE[agent.status];
  const first = agent.events[0]?.at;
  const elapsed = first ? (live ? now : (agent.events.at(-1)?.at ?? now)) - first : 0;

  return (
    <article
      className={cn(
        "relative flex min-h-0 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 transition-shadow duration-300",
        agent.status === "blocked" && "ring-2 ring-span-http/70",
        glow && "shadow-[0_0_0_6px] shadow-span-http/20 ring-2 ring-span-http",
        focused && !glow && "ring-2 ring-foreground/40",
      )}
    >
      <header className="flex items-center gap-2.5 border-b border-border px-3.5 py-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary font-heading text-base" title={`Say “${agent.id}” to address this agent`}>
          {agent.id}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-semibold">{agentName(agent)}</p>
          <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            <Dot className={status.dot} />
            {agent.startsAt ? "starting" : status.label} · {formatDuration(elapsed)}
          </p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={() => setFocus(agent.id)} aria-label={`Open ${agentName(agent)}`}>
          <Maximize2 />
        </Button>
      </header>

      {/* Now: the one line a controller needs at a glance */}
      <p className={cn("border-b border-border px-3.5 py-2 font-mono text-[12px] leading-snug", live ? "text-foreground" : "text-muted-foreground")}>
        <span className="mr-1.5 text-[10.5px] tracking-wide text-muted-foreground uppercase">now</span>
        <span className="break-words">{currentAction(agent) || "…"}</span>
      </p>

      {agent.approval && (
        <div className="border-b border-border p-2.5">
          <ApprovalCard approval={agent.approval} compact label={agentName(agent)} />
        </div>
      )}
      {agent.startsAt && (
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-2 text-xs">
          <span className="text-muted-foreground">Starting in {Math.max(0, Math.ceil((agent.startsAt - now) / 1000))}s</span>
          <Button size="xs" variant="outline" className="ml-auto" onClick={() => send({ type: "cancel_start", id: agent.id })}>
            Undo
          </Button>
        </div>
      )}

      <Stream agent={agent} />
    </article>
  );
}

function Stream({ agent }: { agent: AgentView }) {
  const ref = useRef<HTMLOListElement>(null);
  const events = agent.events.slice(-40);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [agent.events.length]);
  if (!events.length) return <p className="flex-1 px-3.5 py-3 font-mono text-xs text-muted-foreground">waiting for the first step…</p>;
  return (
    <ol ref={ref} className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2 [scrollbar-width:thin]">
      <AnimatePresence initial={false}>
        {events.map((e, i) => {
          const style = EVENT_STYLE[e.kind];
          const { name, detail } = e.kind === "tool" ? splitTool(e.text) : { name: style.label, detail: e.text };
          const human = e.kind === "steer" || e.kind === "approval";
          return (
            <motion.li
              key={`${e.at}-${i}`}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
              className={cn("flex items-baseline gap-2 py-[3px] text-[12px] leading-snug", human && "-mx-1.5 rounded px-1.5 bg-span-http/10")}
            >
              <Dot className={cn("translate-y-[-1px]", style.dot)} />
              <span className={cn("shrink-0 font-semibold", human && "text-span-http", e.kind === "result" && "text-span-workflow", e.kind === "error" && "text-span-error")}>
                {name}
              </span>
              <span className={cn("min-w-0 truncate text-muted-foreground", e.kind === "tool" && "font-mono text-[11.5px]", human && "text-foreground")}>{detail}</span>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}
