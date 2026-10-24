import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { ArrowUp, Check, Minimize2, Square } from "lucide-react";
import type { AgentEvent, AgentView } from "../../server/types.ts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { Dot, Pill } from "@/components/pill";
import { Markdown } from "@/components/markdown";
import { ApprovalCard } from "@/components/incident/approval-card";
import { useNow } from "@/hooks/use-now";
import { EVENT_STYLE, STATUS_STYLE, formatDuration, splitTool } from "@/lib/spans";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

// One agent, full size: complete history plus a direct line to it.
// The other agents keep working in the strip alongside.
export function FocusView({ agent }: { agent: AgentView }) {
  const setFocus = useTower((s) => s.setFocus);
  const send = useTower((s) => s.send);
  const live = agent.status === "working" || agent.status === "starting";
  const now = useNow(1000, live);
  const status = STATUS_STYLE[agent.status];
  const first = agent.events[0]?.at;
  const elapsed = first ? (live ? now : (agent.events.at(-1)?.at ?? now)) - first : 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocus(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setFocus]);

  return (
    <motion.section
      key={agent.id}
      initial={{ opacity: 0, scale: 0.985 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.18 }}
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10"
    >
      <header className="flex flex-col gap-3 border-b border-border px-5 py-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="grid size-8 place-items-center rounded-md bg-secondary font-heading">{agent.id}</span>
          <h2 className="font-mono text-base font-medium whitespace-nowrap">
            agent-{agent.id}
            {agent.role && <span className="ml-2 font-sans font-semibold">{agent.role}</span>}
          </h2>
          <Pill className={status.className}>
            <Dot className={status.dot} />
            {status.label}
          </Pill>
          <Pill>{formatDuration(elapsed)}</Pill>
          <Pill>${agent.costUsd.toFixed(4)}</Pill>
          <Pill>{agent.events.filter((e) => e.kind === "tool").length} tools</Pill>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={agent.status !== "working"}
              onClick={() => send({ type: "control", id: agent.id, action: "stop" })}
            >
              <Square data-icon="inline-start" /> Stop
            </Button>
            <Button variant="outline" size="sm" onClick={() => send({ type: "control", id: agent.id, action: "approve" })}>
              <Check data-icon="inline-start" /> Approve
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setFocus(null)}>
              <Minimize2 data-icon="inline-start" /> Minimize <Kbd className="ml-1">Esc</Kbd>
            </Button>
          </div>
        </div>
        <p className="text-sm leading-snug text-muted-foreground">{agent.task}</p>
        {agent.approval && <ApprovalCard approval={agent.approval} />}
      </header>

      <Timeline events={agent.events} />
      <Composer agentId={agent.id} />
    </motion.section>
  );
}

function Timeline({ events }: { events: AgentEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // follow new events unless the user scrolled up

  useEffect(() => {
    if (pinned.current) ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: "smooth" });
  }, [events.length]);

  const start = events[0]?.at ?? 0;

  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto px-5 py-4 [scrollbar-width:thin]"
    >
      {events.length === 0 && <p className="font-mono text-xs text-muted-foreground">booting agent…</p>}
      <ol className="relative flex flex-col gap-1 border-l border-border pl-5">
        {events.map((e, i) => (
          <TimelineItem key={`${e.at}-${i}`} event={e} rel={e.at - start} />
        ))}
      </ol>
    </div>
  );
}

function TimelineItem({ event, rel }: { event: AgentEvent; rel: number }) {
  const style = EVENT_STYLE[event.kind];
  const marker = <Dot className={cn("absolute top-[9px] -left-[24.5px] ring-4 ring-card", style.dot)} />;
  const time = <span className="ml-auto shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">+{formatDuration(rel)}</span>;

  if (event.kind === "tool") {
    const { name, detail } = splitTool(event.text);
    return (
      <li className="relative flex items-center gap-2.5 py-1">
        {marker}
        <span className="text-[13px] font-semibold">{name}</span>
        <span className="truncate font-mono text-xs text-muted-foreground">{detail}</span>
        {time}
      </li>
    );
  }

  return (
    <li
      className={cn(
        "relative my-1 rounded-lg px-3 py-2.5",
        event.kind === "steer" && "bg-span-http/10",
        event.kind === "result" && "bg-span-workflow/8",
        event.kind === "error" && "bg-span-error/8",
        event.kind === "text" && "-mx-3",
      )}
    >
      {marker}
      <div className="mb-1 flex items-center gap-2">
        <span className={cn("font-mono text-[11px] uppercase tracking-wide", kindText(event.kind))}>{style.label}</span>
        {time}
      </div>
      {event.kind === "steer" || event.kind === "error" ? (
        <p className="text-[13.5px] leading-relaxed">{event.text}</p>
      ) : (
        <Markdown>{event.text}</Markdown>
      )}
    </li>
  );
}

function kindText(kind: AgentEvent["kind"]): string {
  return {
    text: "text-span-chat",
    tool: "text-span-tool",
    steer: "text-span-http",
    result: "text-span-workflow",
    error: "text-span-error",
    approval: "text-span-http",
  }[kind];
}

function Composer({ agentId }: { agentId: string }) {
  const send = useTower((s) => s.send);
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => ref.current?.focus(), [agentId]);

  const submit = () => {
    if (!text.trim()) return;
    send({ type: "direct", id: agentId, text: text.trim() });
    setText("");
  };

  return (
    <div className="border-t border-border p-4">
      <div className="relative">
        <Textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          placeholder={`Message agent-${agentId}…`}
          className="min-h-16 resize-none pr-12"
        />
        <Button size="icon-sm" className="absolute right-2 bottom-2" onClick={submit} disabled={!text.trim()} aria-label="Send">
          <ArrowUp />
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        Goes straight to this agent. Voice works too: instructions that don’t name another agent go here.
      </p>
    </div>
  );
}
