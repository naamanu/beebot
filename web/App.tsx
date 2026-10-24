import { useEffect, useState } from "react";
import { Loader2, WifiOff } from "lucide-react";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CommandBar, attachFiles } from "@/components/command-bar";
import { DecisionFeed } from "@/components/decision-feed";
import { EmptyState } from "@/components/empty-state";
import { PostmortemPage } from "@/components/incident/postmortem-page";
import { RunDetail } from "@/components/runs/run-detail";
import { RunsPage } from "@/components/runs/runs-page";
import { AgentSheet } from "@/components/tasks/agent-sheet";
import { TaskDetail } from "@/components/tasks/task-detail";
import { TaskList } from "@/components/tasks/task-list";
import { TopBar } from "@/components/top-bar";
import { useMic } from "@/hooks/use-mic";
import { useRoute } from "@/hooks/use-route";
import { useAutoSelectNewTasks, useTasks } from "@/hooks/use-tasks";
import { queryClient } from "@/lib/api";
import { connectTower, useTower } from "@/lib/store";

export function App() {
  const mic = useMic();
  const route = useRoute();
  useEffect(() => connectTower(), []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider delayDuration={200}>
        <div className="flex h-dvh flex-col overflow-hidden bg-background">
          <TopBar />
          <ConnectionNotice />
          {route.page === "tower" ? (
            <TasksView micOn={mic.on} onToggleMic={mic.toggle} />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 lg:overflow-hidden">
              {route.page === "run" ? (
                <RunDetail key={route.id} id={route.id} />
              ) : route.page === "postmortem" ? (
                <PostmortemPage />
              ) : (
                <ActivityView taskId={route.taskId} />
              )}
            </div>
          )}
        </div>
        <AgentSheet />
        <Toaster position="top-center" />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

// Tasks on the left, the selected task on the right, one input underneath.
function TasksView({ micOn, onToggleMic }: { micOn: boolean; onToggleMic: () => void }) {
  const tasks = useTasks();
  const selectedId = useTower((s) => s.selectedTaskId);
  const selected = tasks.find((t) => t.id === selectedId) ?? null;
  const [dragging, setDragging] = useState(false);
  useAutoSelectNewTasks(tasks);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 p-2 md:flex-row md:p-3">
      <TaskList tasks={tasks} />
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
        {selected ? (
          <TaskDetail key={selected.id} task={selected} />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col rounded-xl bg-card ring-1 ring-foreground/10">
            <EmptyState />
          </div>
        )}
        <CommandBar micOn={micOn} onToggleMic={onToggleMic} />
      </div>
    </div>
  );
}

function ConnectionNotice() {
  const status = useTower((s) => s.connectionStatus);
  if (status === "connected") return null;
  return (
    <div role="status" className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-4 py-2 text-xs text-muted-foreground">
      {status === "connecting" ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <WifiOff className="size-3.5 shrink-0" />}
      <span>{status === "connecting" ? "Connecting to Control Tower…" : "Connection lost. Reconnecting automatically; sending is paused and your drafts are kept."}</span>
    </div>
  );
}

// Everything that happened: runs and traces, plus the router's decisions.
function ActivityView({ taskId }: { taskId: string | null }) {
  return (
    <div className="flex min-h-0 flex-1 gap-3">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <RunsPage taskId={taskId} />
      </div>
      <aside className="hidden min-h-0 w-[360px] shrink-0 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 xl:flex">
        <DecisionFeed />
      </aside>
    </div>
  );
}
