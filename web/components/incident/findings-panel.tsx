import { AnimatePresence, motion } from "motion/react";
import type { IncidentView } from "../../../server/types.ts";
import { Dot } from "@/components/pill";
import { ApprovalCard } from "./approval-card";
import { useTower } from "@/lib/store";

// The commander's side panel during an incident: pending approvals first,
// then what the investigators have found.
export function ApprovalsPanel() {
  const agents = useTower((s) => s.agents);
  const waiting = agents.filter((a) => a.approval);
  if (waiting.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 border-b border-border bg-span-http/5 p-4">
      <h3 className="text-sm text-muted-foreground">Waiting for you</h3>
      {waiting.map((a) => (
        <ApprovalCard key={a.approval!.id} approval={a.approval!} label={`${a.role ?? "Agent"} (agent ${a.id})`} />
      ))}
    </section>
  );
}

const ROLE_DOT: Record<string, string> = {
  Logs: "bg-span-chat",
  Changes: "bg-span-tool",
  Metrics: "bg-span-workflow",
  Comms: "bg-span-http",
};

export function FindingsPanel({ incident }: { incident: IncidentView }) {
  return (
    <section className="max-h-[40%] min-h-0 overflow-y-auto border-t border-border p-4 [scrollbar-width:thin]">
      <h3 className="mb-2 text-sm text-muted-foreground">Findings</h3>
      {incident.findings.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Investigators record what they find here.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          <AnimatePresence initial={false}>
            {[...incident.findings].reverse().map((f) => (
              <motion.li key={f.at} initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="text-[13px] leading-snug">
                <span className="mb-0.5 flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
                  <Dot className={ROLE_DOT[f.role] ?? "bg-muted-foreground"} />
                  {f.role} · {new Date(f.at).toLocaleTimeString()}
                </span>
                {f.text}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}
