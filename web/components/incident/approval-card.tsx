import { Check, ShieldAlert, X } from "lucide-react";
import type { Approval } from "../../../server/types.ts";
import { Button } from "@/components/ui/button";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

// A risky action waiting for a human. Approve or deny here, or by voice.
export function ApprovalCard({ approval, compact = false, label }: { approval: Approval; compact?: boolean; label?: string }) {
  const send = useTower((s) => s.send);
  const connected = useTower((s) => s.connected);
  return (
    <div className={cn("flex flex-col gap-2 rounded-lg border border-span-http/50 bg-span-http/10", compact ? "p-2.5" : "p-3")}>
      <p className="flex items-start gap-2 text-[13px] leading-snug">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-span-http" />
        <span>
          <span className="font-semibold">{label ?? `Agent ${approval.agentId}`} wants to:</span> {approval.summary}
        </span>
      </p>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!connected} onClick={() => send({ type: "approval", id: approval.id, decision: "approve" })}>
          <Check data-icon="inline-start" /> Approve
        </Button>
        <Button size="sm" variant="outline" disabled={!connected} onClick={() => send({ type: "approval", id: approval.id, decision: "deny" })}>
          <X data-icon="inline-start" /> Deny
        </Button>
        {!compact && <span className="ml-auto text-xs text-muted-foreground">or say “approve”</span>}
      </div>
    </div>
  );
}
