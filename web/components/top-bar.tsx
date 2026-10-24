import { Mic, MicOff, Play, RadioTower, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dot, Pill } from "@/components/pill";
import { DeclareIncidentDialog } from "@/components/incident/declare-dialog";
import { navigate, useRoute } from "@/hooks/use-route";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

export function TopBar({ micOn, onToggleMic }: { micOn: boolean; onToggleMic: () => void }) {
  const connected = useTower((s) => s.connected);
  const agents = useTower((s) => s.agents);
  const rules = useTower((s) => s.rules.length);
  const send = useTower((s) => s.send);
  const level = useTower((s) => s.levels.at(-1) ?? 0);
  const cost = agents.reduce((sum, a) => sum + a.costUsd, 0);
  const working = agents.filter((a) => a.status === "working").length;
  const route = useRoute();
  const incident = useTower((s) => s.incident);

  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-border px-5">
      <div className="flex items-center gap-3">
        <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
          <RadioTower className="size-4" />
        </div>
        <h1 className="text-xl tracking-tight">Control Tower</h1>
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

      <div className="hidden items-center gap-2 md:flex">
        <Pill className={cn(connected ? "border-span-tool/40 text-span-tool" : "border-span-error/40 text-span-error")}>
          <Dot className={connected ? "bg-span-tool" : "bg-span-error"} />
          {connected ? "connected" : "offline"}
        </Pill>
        {agents.length > 0 && (
          <>
            <Pill>
              {working}/{agents.length} working
            </Pill>
            <Pill>${cost.toFixed(4)}</Pill>
            <Pill>
              {rules} rule{rules === 1 ? "" : "s"}
            </Pill>
          </>
        )}
      </div>

      <div className="ml-auto flex items-center gap-2">
        {!incident && <DeclareIncidentDialog />}
        {agents.length === 0 ? (
          <Button variant="outline" onClick={() => send({ type: "start", tasks: [] })} disabled={!connected}>
            <Play data-icon="inline-start" /> Demo tasks
          </Button>
        ) : (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" disabled={!connected}>
                <Trash2 data-icon="inline-start" /> Reset
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Stop all {agents.length} agents?</AlertDialogTitle>
                <AlertDialogDescription>
                  Running agents are stopped and the board is cleared. Their branches stay on disk under .runs/, and standing rules are kept.
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
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="lg"
              onClick={onToggleMic}
              disabled={!connected}
              className={cn(
                "relative min-w-36 rounded-full px-4",
                micOn && "bg-span-error text-white hover:bg-span-error/90",
              )}
            >
              {micOn && (
                <motion.span
                  aria-hidden
                  className="absolute inset-0 rounded-full ring-2 ring-span-error"
                  animate={{ scale: 1 + Math.min(level * 2.5, 0.35), opacity: 0.25 + Math.min(level * 3, 0.6) }}
                  transition={{ duration: 0.08 }}
                />
              )}
              {micOn ? <Mic data-icon="inline-start" /> : <MicOff data-icon="inline-start" />}
              {micOn ? "Listening" : "Talk"}
              {!micOn && <Kbd className="ml-1 bg-primary-foreground/10 text-primary-foreground">Space</Kbd>}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Click to toggle, or hold Space</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
