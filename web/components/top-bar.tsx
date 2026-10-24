import { useState } from "react";
import { Ellipsis, Eraser, Play, RadioTower, Trash2 } from "lucide-react";
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
import { formatCost } from "@/lib/format";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

export function TopBar() {
  const connected = useTower((s) => s.connected);
  const agents = useTower((s) => s.agents);
  const rules = useTower((s) => s.rules.length);
  const send = useTower((s) => s.send);
  const route = useRoute();
  const [confirmReset, setConfirmReset] = useState(false);
  const cost = agents.reduce((sum, a) => sum + a.costUsd, 0);
  const working = agents.filter((a) => a.status === "working").length;
  const waiting = agents.filter((a) => a.approval).length;

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border px-5">
      <div className="flex items-center gap-2.5">
        <div className="grid size-7 place-items-center rounded-lg bg-primary text-primary-foreground">
          <RadioTower className="size-4" />
        </div>
        <h1 className="text-lg tracking-tight">Control Tower</h1>
      </div>

      <nav className="flex items-center gap-1 rounded-lg bg-secondary p-0.5" aria-label="Views">
        {(
          [
            ["/", "Tower", route.page === "tower" || route.page === "postmortem"],
            ["/runs", "Runs", route.page === "runs" || route.page === "run"],
          ] as const
        ).map(([path, label, active]) => (
          <button
            key={path}
            onClick={() => navigate(path)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground",
              active && "bg-card text-foreground shadow-sm ring-1 ring-foreground/10",
            )}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {/* One compact status summary */}
        <Pill className={cn(!connected && "border-span-error/40 text-span-error")}>
          <Dot className={connected ? (working ? "animate-pulse bg-span-retrieval" : "bg-span-tool") : "bg-span-error"} />
          {!connected
            ? "offline"
            : agents.length
              ? `${working}/${agents.length} working · ${formatCost(cost)}${rules ? ` · ${rules} rule${rules === 1 ? "" : "s"}` : ""}`
              : "ready"}
        </Pill>
        {waiting > 0 && <Pill className="border-span-http/50 bg-span-http/15 text-span-http">{waiting} waiting for approval</Pill>}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={() => send({ type: "start", tasks: [] })} disabled={!connected}>
              <Play /> Load 4 demo coding tasks
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => send({ type: "clear_rules" })} disabled={!rules}>
              <Eraser /> Clear standing rules
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirmReset(true)} disabled={!agents.length}>
              <Trash2 /> Reset board…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop all {agents.length} agents?</AlertDialogTitle>
            <AlertDialogDescription>
              Running agents are stopped and the board is cleared. Their work stays on disk under .runs/, runs stay in the Runs view, and standing
              rules are kept.
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
