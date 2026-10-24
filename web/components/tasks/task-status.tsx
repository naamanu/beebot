import { CheckCircle2, CircleAlert, CircleSlash, Hand, Loader2, Sparkles, XCircle } from "lucide-react";
import type { TaskStatus } from "../../../server/types.ts";
import { cn } from "@/lib/utils";

export const TASK_STATUS: Record<TaskStatus, { label: string; icon: React.ComponentType<{ className?: string }>; className: string }> = {
  needs_you: { label: "Needs you", icon: Hand, className: "text-span-http" },
  planning: { label: "Planning", icon: Sparkles, className: "text-span-chat" },
  working: { label: "Working", icon: Loader2, className: "text-span-retrieval" },
  ready: { label: "Ready for review", icon: CheckCircle2, className: "text-span-tool" },
  done: { label: "Done", icon: CheckCircle2, className: "text-span-tool" },
  stopped: { label: "Stopped", icon: CircleSlash, className: "text-muted-foreground" },
  failed: { label: "Failed", icon: XCircle, className: "text-span-error" },
};

// Status is always an icon plus a word, never colour alone.
export function TaskStatusIcon({ status, className }: { status: TaskStatus; className?: string }) {
  const s = TASK_STATUS[status];
  return <s.icon className={cn("size-4 shrink-0", s.className, status === "working" && "animate-spin", className)} aria-label={s.label} />;
}

export function TaskStatusLabel({ status }: { status: TaskStatus }) {
  const s = TASK_STATUS[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-sm font-medium", s.className)}>
      <TaskStatusIcon status={status} />
      {s.label}
    </span>
  );
}

export { CircleAlert };
