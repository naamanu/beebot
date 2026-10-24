import { useEffect } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentCard } from "@/components/agent-card";
import { AgentStrip } from "@/components/agent-strip";
import { DecisionFeed } from "@/components/decision-feed";
import { EmptyState } from "@/components/empty-state";
import { FocusView } from "@/components/focus-view";
import { HeardPanel } from "@/components/heard-panel";
import { RulesPanel } from "@/components/rules-panel";
import { TopBar } from "@/components/top-bar";
import { useMic } from "@/hooks/use-mic";
import { connectTower, useTower } from "@/lib/store";
import type { AgentView } from "../server/types.ts";

// Fill the available space whatever the agent count: 1 → full, 2 → side by
// side, 3–4 → 2×2 (an odd last card spans the row), 5+ → three columns.
function AgentGrid({ agents }: { agents: AgentView[] }) {
  const n = agents.length;
  const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
  const rows = Math.ceil(n / cols);
  const lastSpans = n % cols !== 0 ? cols - (n % cols) + 1 : 1;
  return (
    <div
      className="grid min-h-0 flex-1 auto-rows-[minmax(320px,auto)] grid-cols-1 gap-3 lg:grid-cols-[repeat(var(--cols),minmax(0,1fr))] lg:grid-rows-[repeat(var(--rows),minmax(0,1fr))]"
      style={{ "--cols": cols, "--rows": rows } as React.CSSProperties}
    >
      {agents.map((a, i) => (
        <div
          key={a.id}
          className="flex min-h-0 *:flex-1 lg:col-span-(--span)"
          style={{ "--span": i === n - 1 ? lastSpans : 1 } as React.CSSProperties}
        >
          <AgentCard agent={a} />
        </div>
      ))}
    </div>
  );
}

export function App() {
  const agents = useTower((s) => s.agents);
  const focused = useTower((s) => s.focused);
  const mic = useMic();

  useEffect(() => connectTower(), []);

  const open = agents.find((a) => a.id === focused);

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        <TopBar micOn={mic.on} onToggleMic={mic.toggle} />
        {/* Below lg the page scrolls; from lg up everything fits the viewport. */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 lg:flex-row lg:overflow-hidden">
          <main className="flex min-h-0 min-w-0 flex-1 gap-3">
            {open ? (
              <>
                <FocusView agent={open} />
                {agents.length > 1 && <AgentStrip agents={agents.filter((a) => a.id !== open.id)} />}
              </>
            ) : agents.length === 0 ? (
              <div className="flex flex-1 rounded-xl bg-card ring-1 ring-foreground/10">
                <EmptyState />
              </div>
            ) : (
              <AgentGrid agents={agents} />
            )}
          </main>
          <aside className="flex min-h-[560px] shrink-0 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 lg:min-h-0 lg:w-[360px]">
            <HeardPanel micOn={mic.on} />
            <DecisionFeed />
            <RulesPanel />
          </aside>
        </div>
      </div>
      <Toaster position="bottom-left" />
    </TooltipProvider>
  );
}
