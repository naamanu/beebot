import { useState } from "react";
import { Ellipsis, Hand, ListChecks, Play, RadioTower, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dot, Pill } from "@/components/pill";
import { navigate, useRoute } from "@/hooks/use-route";
import { useTasks } from "@/hooks/use-tasks";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCost } from "@/lib/format";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

export function TopBar() {
  const connected = useTower((s) => s.connected);
  const connectionStatus = useTower((s) => s.connectionStatus);
  const ruleList = useTower((s) => s.rules);
  const rules = ruleList.length;
  const tasks = useTasks();
  const needYou = tasks.filter((t) => t.status === "needs_you" || t.status === "ready");
  const selectTask = useTower((s) => s.selectTask);
  const [showRules, setShowRules] = useState(false);
  const send = useTower((s) => s.send);
  const route = useRoute();
  const [confirmReset, setConfirmReset] = useState(false);
  const cost = tasks.reduce((sum, task) => sum + task.costUsd, 0);
  // A task waiting on you is still active work.
  const working = tasks.filter((task) => task.status === "working" || task.status === "planning" || task.status === "needs_you").length;

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:gap-4 sm:px-5">
      <div className="flex shrink-0 items-center gap-2.5">
        <div className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">
          <RadioTower className="size-4" />
        </div>
        <h1 className="hidden text-lg tracking-tight sm:block">Control Tower</h1>
        <span className="sr-only sm:hidden">Control Tower</span>
      </div>

      <nav className="flex items-center gap-1 rounded-lg bg-secondary p-0.5" aria-label="Views">
        {(
          [
            ["/", "Tasks", route.page === "tower" || route.page === "postmortem"],
            ["/runs", "Activity", route.page === "runs" || route.page === "run"],
          ] as const
        ).map(([path, label, active]) => (
          <button
            key={path}
            onClick={() => navigate(path)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
              active && "bg-card text-foreground shadow-sm ring-1 ring-foreground/10",
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
        {/* One compact status summary */}
        <Pill className={cn("hidden lg:inline-flex", !connected && "border-span-error/40 text-span-error")}>
          <Dot className={connected ? (working ? "animate-pulse bg-span-retrieval" : "bg-span-tool") : "bg-span-error"} />
          {!connected
            ? connectionStatus === "connecting" ? "connecting" : "reconnecting"
            : tasks.length
              ? `${working ? `${working} task${working === 1 ? "" : "s"} active` : "idle"} · ${formatCost(cost)}`
              : "ready"}
        </Pill>
        {needYou.length > 0 && (
          <button
            onClick={() => {
              selectTask(needYou[0]!.id);
              navigate("/");
            }}
            aria-label={`${needYou.length} task${needYou.length === 1 ? "" : "s"} need${needYou.length === 1 ? "s" : ""} your attention`}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-span-http px-2.5 text-xs font-medium text-white hover:bg-span-http/90 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Hand className="size-3.5" /> {needYou.length}<span className="hidden min-[400px]:inline">need{needYou.length === 1 ? "s" : ""} you</span>
          </button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => send({ type: "start", tasks: [] })} disabled={!connected}>
              <Play /> Start 4 demo coding tasks
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setShowRules(true)}>
              <ListChecks /> Standing rules{rules ? ` (${rules})` : ""}…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmReset(true)} disabled={!connected || !tasks.length}>
              <Trash2 /> Clear all tasks…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <Dialog open={showRules} onOpenChange={setShowRules}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Standing rules</DialogTitle>
            <DialogDescription>Rules every agent follows. Add one by saying “from now on…”.</DialogDescription>
          </DialogHeader>
          {rules === 0 ? (
            <p className="text-sm text-muted-foreground">No rules yet.</p>
          ) : (
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm">
              {ruleList.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          {rules > 0 && (
            <Button variant="outline" size="sm" className="self-start" disabled={!connected} onClick={() => send({ type: "clear_rules" })}>
              Clear all rules
            </Button>
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all tasks?</AlertDialogTitle>
            <AlertDialogDescription>
              Running agents are stopped and the task list is cleared. Their work stays on disk under .runs/, their history stays in Activity, and
              standing rules are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => send({ type: "reset" })}>
              Stop and clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  );
}
