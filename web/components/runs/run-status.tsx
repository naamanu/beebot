import { CheckCircle2, CircleSlash, Loader2, Square, XCircle } from "lucide-react";
import type { RunStatus } from "../../../server/types.ts";
import { Pill } from "@/components/pill";
import { RUN_STATUS_STYLE } from "@/lib/spans";
import { cn } from "@/lib/utils";

const ICONS: Record<RunStatus, React.ComponentType<{ className?: string }>> = {
  running: Loader2,
  success: CheckCircle2,
  error: XCircle,
  stopped: Square,
  interrupted: CircleSlash,
};

// Status is never color alone: always an icon and a label.
export function RunStatusPill({ status, className }: { status: RunStatus; className?: string }) {
  const Icon = ICONS[status];
  return (
    <Pill className={cn(RUN_STATUS_STYLE[status].className, className)}>
      <Icon className={cn("size-3", status === "running" && "animate-spin")} />
      {RUN_STATUS_STYLE[status].label}
    </Pill>
  );
}
