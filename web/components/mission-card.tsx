import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, GitMerge, ListChecks, Loader2, Pencil, TriangleAlert, Users, X } from "lucide-react";
import type { MissionView } from "../../server/types.ts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dot, Pill } from "@/components/pill";
import { formatCost } from "@/lib/format";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<MissionView["status"], string> = {
  planning: "analyzing the task",
  awaiting_approval: "waiting for your approval",
  allocating: "deciding how many agents",
  running: "running",
  synthesizing: "lead is combining results",
  done: "done",
  cancelled: "cancelled",
  failed: "failed",
};

const WORKER_DOT: Record<string, string> = {
  waiting: "bg-muted-foreground/40",
  running: "bg-span-retrieval animate-pulse",
  done: "bg-span-tool",
  error: "bg-span-error",
};

// Newest missions first; finished ones collapse to a line.
export function MissionPanel({ grow = false }: { grow?: boolean }) {
  const missions = useTower((s) => s.missions);
  const visible = missions.filter((m) => m.status !== "cancelled").slice(0, 3);
  if (!visible.length) return null;
  return (
    <div className={cn("flex shrink-0 flex-col gap-3 overflow-y-auto [scrollbar-width:thin]", grow ? "min-h-0 flex-1" : "max-h-[55%]")}>
      <AnimatePresence initial={false}>
        {visible.map((m) => (
          <motion.div key={m.id} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <MissionCard mission={m} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function MissionCard({ mission: m }: { mission: MissionView }) {
  const finished = m.status === "done" || m.status === "failed";
  const [open, setOpen] = useState(!finished);
  const busy = m.status === "planning" || m.status === "allocating";

  return (
    <section
      className={cn(
        "rounded-xl bg-card ring-1 ring-foreground/10",
        m.status === "awaiting_approval" && "ring-2 ring-span-http/60",
      )}
    >
      <button className="flex w-full items-center gap-3 px-4 py-3 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-secondary">
          {busy ? <Loader2 className="size-4 animate-spin" /> : m.status === "awaiting_approval" ? <ListChecks className="size-4" /> : <Users className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] font-medium">{m.request}</p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {m.template === "coding" ? "Code" : "General"} task{m.files.length ? ` · ${m.files.length} file${m.files.length === 1 ? "" : "s"}` : ""} ·{" "}
            <span className={cn(m.status === "awaiting_approval" && "text-span-http", m.status === "failed" && "text-span-error")}>{STATUS_LABEL[m.status]}</span>
          </p>
        </div>
        {m.allocation && (
          <Pill>
            {m.allocation.workstreams.length} agent{m.allocation.workstreams.length === 1 ? "" : "s"}
            {m.allocation.synthesis ? " + lead" : ""}
          </Pill>
        )}
        <Pill title="Planning and allocation calls; each agent reports its own cost">{formatCost(m.costUsd)} planning</Pill>
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="border-t border-border px-4 py-3">
          {m.status === "planning" && <p className="text-sm text-muted-foreground">{m.revisions.length ? "Revising the plan with your notes…" : "Reading the task and the inputs, outlining the steps…"}</p>}
          {m.error && <p className="text-sm text-span-error">{m.error}</p>}
          {m.plan && <PlanView mission={m} />}
          {m.status === "awaiting_approval" && <ApprovalBar missionId={m.id} />}
          {m.status === "allocating" && <p className="mt-3 text-sm text-muted-foreground">Plan approved. Deciding how many agents the steps need…</p>}
          {m.allocation && <AllocationView mission={m} />}
        </div>
      )}
    </section>
  );
}

function PlanView({ mission: m }: { mission: MissionView }) {
  const plan = m.plan!;
  const owner = (stepId: string) =>
    m.allocation?.workstreams.find((w) => w.stepIds.includes(stepId))?.name ?? ((m.allocation?.leadStepIds ?? []).includes(stepId) ? "Lead" : undefined);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13.5px] leading-snug">{plan.summary}</p>
      <ol className="flex flex-col gap-1.5">
        {plan.steps.map((s) => (
          <li key={s.id} className="flex items-start gap-3 rounded-lg bg-secondary/50 px-3 py-2">
            <span className="mt-0.5 font-mono text-[11px] text-muted-foreground">{s.id}</span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">{s.title}</p>
              <p className="text-[12.5px] leading-snug text-muted-foreground">{s.detail}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              {s.dependsOn.length > 0 && <span className="font-mono text-[10.5px] text-muted-foreground">after {s.dependsOn.join(", ")}</span>}
              {owner(s.id) && <span className="text-[11px] font-medium">{owner(s.id)}</span>}
            </div>
          </li>
        ))}
      </ol>
      {plan.risks.length > 0 && (
        <div className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>{plan.risks.join(" · ")}</span>
        </div>
      )}
      {m.revisions.length > 0 && <p className="font-mono text-[11px] text-muted-foreground">Revised with: {m.revisions.map((r) => `“${r}”`).join(", ")}</p>}
    </div>
  );
}

function ApprovalBar({ missionId }: { missionId: string }) {
  const send = useTower((s) => s.send);
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState("");
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
      {revising ? (
        <form
          className="flex flex-1 gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!note.trim()) return;
            send({ type: "plan_decision", missionId, decision: "revise", note: note.trim() });
            setNote("");
            setRevising(false);
          }}
        >
          <Input autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change? e.g. “skip step 4, add a chart per region”" className="h-8 text-sm" />
          <Button size="sm" type="submit" disabled={!note.trim()}>
            Revise
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setRevising(false)}>
            Back
          </Button>
        </form>
      ) : (
        <>
          <Button size="sm" onClick={() => send({ type: "plan_decision", missionId, decision: "approve" })}>
            <Check data-icon="inline-start" /> Approve plan
          </Button>
          <Button size="sm" variant="outline" onClick={() => setRevising(true)}>
            <Pencil data-icon="inline-start" /> Revise
          </Button>
          <Button size="sm" variant="ghost" onClick={() => send({ type: "plan_decision", missionId, decision: "cancel" })}>
            <X data-icon="inline-start" /> Cancel
          </Button>
          <span className="ml-auto text-xs text-muted-foreground">or say “approve the plan” · after approval, the planner decides how many agents</span>
        </>
      )}
    </div>
  );
}

function AllocationView({ mission: m }: { mission: MissionView }) {
  const setFocus = useTower((s) => s.setFocus);
  const a = m.allocation!;
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
      <p className="text-[12.5px] leading-snug text-muted-foreground">{a.reasoning}</p>
      <div className="flex flex-wrap items-center gap-2">
        {a.workstreams.map((w) => {
          const worker = m.workers.find((x) => x.name === w.name);
          return (
            <button
              key={w.name}
              disabled={!worker?.agentId}
              onClick={() => worker?.agentId && setFocus(worker.agentId)}
              title={w.rationale}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs enabled:hover:bg-accent disabled:opacity-60"
            >
              <Dot className={WORKER_DOT[worker?.state ?? "waiting"]} />
              <span className="font-medium">{w.name}</span>
              <span className="font-mono text-[10.5px] text-muted-foreground">
                {w.stepIds.join(" ")}
                {worker?.agentId ? ` · agent ${worker.agentId}` : w.after.length ? ` · after ${w.after.join(", ")}` : ""}
              </span>
            </button>
          );
        })}
        {a.synthesis && (
          <button
            disabled={!m.leadAgentId}
            onClick={() => m.leadAgentId && setFocus(m.leadAgentId)}
            className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 text-xs enabled:hover:bg-accent disabled:opacity-60"
          >
            <GitMerge className="size-3.5" />
            <span className="font-medium">Lead</span>
            <span className="font-mono text-[10.5px] text-muted-foreground">
              {(a.leadStepIds ?? []).join(" ")}
              {m.leadAgentId ? ` · agent ${m.leadAgentId}` : " · combines at the end"}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}
