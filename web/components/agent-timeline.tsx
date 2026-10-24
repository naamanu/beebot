import { useEffect, useRef } from "react";
import type { AgentEvent } from "../../server/types.ts";
import { Dot } from "@/components/pill";
import { Markdown } from "@/components/markdown";
import { EVENT_STYLE, formatDuration, splitTool } from "@/lib/spans";
import { cn } from "@/lib/utils";

// An agent's full history: tool calls as compact rows, messages, steers,
// approvals and results as blocks.
export function Timeline({ events }: { events: AgentEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // follow new events unless the user scrolled up

  useEffect(() => {
    if (pinned.current) ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
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
