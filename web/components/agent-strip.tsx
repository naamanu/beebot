import type { AgentView } from "../../server/types.ts";
import { Dot } from "@/components/pill";
import { EVENT_STYLE, STATUS_STYLE, splitTool } from "@/lib/spans";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

// The other agents while one is open: compact, live, click to switch.
export function AgentStrip({ agents }: { agents: AgentView[] }) {
  const setFocus = useTower((s) => s.setFocus);
  const steeredAt = useTower((s) => s.steeredAt);

  return (
    <nav className="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto">
      <p className="px-1 text-xs text-muted-foreground">Still working</p>
      {agents.map((a) => {
        const last = a.events.at(-1);
        const status = STATUS_STYLE[a.status];
        const recentlySteered = Date.now() - (steeredAt[a.id] ?? 0) < 1600;
        return (
          <button
            key={a.id}
            onClick={() => setFocus(a.id)}
            className={cn(
              "flex flex-col gap-1.5 rounded-xl bg-card p-3 text-left ring-1 ring-foreground/10 transition hover:ring-foreground/25",
              recentlySteered && "ring-2 ring-span-http",
            )}
          >
            <span className="flex items-center gap-2">
              <span className="grid size-6 place-items-center rounded-md bg-secondary font-heading text-xs">{a.id}</span>
              <span className="font-mono text-xs font-medium">agent-{a.id}</span>
              <Dot className={cn("ml-auto", status.dot)} />
              <span className="font-mono text-[10.5px] text-muted-foreground">{status.label}</span>
            </span>
            <span className="line-clamp-2 text-xs text-muted-foreground">{a.task}</span>
            {last && (
              <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px]">
                <Dot className={EVENT_STYLE[last.kind].dot} />
                <span className="truncate">{last.kind === "tool" ? splitTool(last.text).name + " " + splitTool(last.text).detail : last.text}</span>
              </span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
