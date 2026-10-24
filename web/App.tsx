import { useEffect } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AgentCard } from "@/components/agent-card";
import { AgentStrip } from "@/components/agent-strip";
import { DecisionFeed } from "@/components/decision-feed";
import { EmptyState } from "@/components/empty-state";
import { FocusView } from "@/components/focus-view";
import { RulesPanel } from "@/components/rules-panel";
import { TopBar } from "@/components/top-bar";
import { CommandBar, attachFiles } from "@/components/command-bar";
import { OutputsPanel } from "@/components/outputs-panel";
import { MissionPanel } from "@/components/mission-card";
import { useState } from "react";
import { useMic } from "@/hooks/use-mic";
import { useRoute } from "@/hooks/use-route";
import { queryClient } from "@/lib/api";
import { RunDetail } from "@/components/runs/run-detail";
import { RunsPage } from "@/components/runs/runs-page";
import { ApprovalsPanel, FindingsPanel } from "@/components/incident/findings-panel";
import { IncidentBar } from "@/components/incident/incident-bar";
import { PostmortemPage } from "@/components/incident/postmortem-page";
import { connectTower, useTower } from "@/lib/store";
import { cn } from "@/lib/utils";
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
  const incident = useTower((s) => s.incident);
  const hasMissions = useTower((s) => s.missions.some((m) => m.status !== "cancelled"));
  const [dragging, setDragging] = useState(false);
  const mic = useMic();
  const route = useRoute();

  useEffect(() => connectTower(), []);

  const open = agents.find((a) => a.id === focused);

  return (
    <QueryClientProvider client={queryClient}>
    <TooltipProvider delayDuration={200}>
      <div className="flex h-dvh flex-col overflow-hidden bg-background">
        <TopBar />
        {route.page !== "tower" ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 lg:overflow-hidden">
            {route.page === "run" ? <RunDetail key={route.id} id={route.id} /> : route.page === "postmortem" ? <PostmortemPage /> : <RunsPage />}
          </div>
        ) : (
        /* Below lg the page scrolls; from lg up everything fits the viewport. */
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 lg:flex-row lg:overflow-hidden">
          <div
            className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-3"
            onDragOver={(e) => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              if (e.dataTransfer.files.length) attachFiles(e.dataTransfer.files, useTower.getState().setDraft);
            }}
          >
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-xl border-2 border-dashed border-foreground/30 bg-background/80">
              <p className="font-heading text-xl">Drop files to attach them</p>
            </div>
          )}
          {incident && <IncidentBar incident={incident} />}
          {!open && <MissionPanel grow={agents.length === 0} />}
          <main className={cn("flex min-h-0 min-w-0 flex-1 gap-3", !open && agents.length === 0 && hasMissions && "hidden")}>
            {open ? (
              <>
                <FocusView agent={open} />
                {open.template === "general" && <OutputsPanel agent={open} />}
                {agents.length > 1 && <AgentStrip agents={agents.filter((a) => a.id !== open.id)} compact={open.template === "general"} />}
              </>
            ) : agents.length === 0 ? (
              hasMissions ? null : <EmptyState />
            ) : (
              <AgentGrid agents={agents} />
            )}
          </main>
          <CommandBar micOn={mic.on} onToggleMic={mic.toggle} />
          </div>
          <aside className="flex min-h-[560px] shrink-0 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 lg:min-h-0 lg:w-[360px]">
            <ApprovalsPanel />
            <DecisionFeed />
            {incident ? <FindingsPanel incident={incident} /> : <RulesPanel />}
          </aside>
        </div>
        )}
      </div>
      <Toaster position="top-center" />
    </TooltipProvider>
    </QueryClientProvider>
  );
}
