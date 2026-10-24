import { useState } from "react";
import { Check, ChevronDown, CircleAlert, FileText, GitBranch, Square, Waypoints } from "lucide-react";
import type { AgentView, TaskView } from "../../../server/types.ts";
import { Button } from "@/components/ui/button";
import { Dot, Pill } from "@/components/pill";
import { Markdown } from "@/components/markdown";
import { ApprovalCard } from "@/components/incident/approval-card";
import { IncidentBar } from "@/components/incident/incident-bar";
import { FindingsPanel } from "@/components/incident/findings-panel";
import { AllocationView, ApprovalBar, PlanView } from "@/components/plan-views";
import { useOutputs } from "@/components/outputs-panel";
import { useNow } from "@/hooks/use-now";
import { navigate } from "@/hooks/use-route";
import { formatCost } from "@/lib/format";
import { STATUS_STYLE, agentName, currentAction, formatDuration } from "@/lib/spans";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";
import { TaskStatusLabel } from "./task-status";
import { LiveAgentCard } from "./live-agent-card";

const isActive = (a: AgentView) => a.status === "working" || a.status === "starting" || a.status === "blocked" || !!a.startsAt;

// While any of its agents is active, a task is shown as a live control tower;
// once they've all stopped, as a story you can review.
export function TaskDetail({ task }: { task: TaskView }) {
  const agents = useTower((s) => s.agents);
  const members = task.agentIds.flatMap((id) => agents.filter((a) => a.id === id));
  return members.some(isActive) ? <LiveTask task={task} members={members} /> : <TaskStory task={task} />;
}

function TaskHeader({ task }: { task: TaskView }) {
  const agents = useTower((s) => s.agents);
  const missions = useTower((s) => s.missions);
  const send = useTower((s) => s.send);
  const connected = useTower((s) => s.connected);
  const mission = task.missionId ? missions.find((m) => m.id === task.missionId) : undefined;
  const members = task.agentIds.flatMap((id) => agents.filter((a) => a.id === id));
  const live = task.status === "working" || task.status === "planning" || task.status === "needs_you";
  const now = useNow(1000, live);
  const working = members.filter((a) => a.status === "working");
  return (
    <header className="flex flex-wrap items-start gap-x-4 gap-y-3 border-b border-border px-4 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-xl leading-tight">{task.title}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <TaskStatusLabel status={task.status} />
            <span className="text-muted-foreground">·</span>
            <span className="text-[13px] text-muted-foreground">
              {{ general: "General", coding: "Code", incident: "Incident" }[task.template]}
              {task.agentIds.length > 0 && ` · ${task.agentIds.length} agent${task.agentIds.length === 1 ? "" : "s"}`}
              {/* Older tasks don't know when they finished: no duration rather than a wrong one. */}
              {(task.endedAt || live) && ` · ${formatDuration((task.endedAt ?? now) - task.createdAt)}`}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Pill title="Agents plus planning">{formatCost(task.costUsd)}</Pill>
          {task.status === "ready" && (
            <Button size="sm" disabled={!connected} onClick={() => send({ type: "complete_task", taskId: task.id })}>
              <Check data-icon="inline-start" /> Mark done
            </Button>
          )}
          {(working.length > 0 || (mission && live)) && (
            <Button size="sm" variant="outline" disabled={!connected} onClick={() => mission ? send({ type: "plan_decision", missionId: mission.id, decision: "cancel" }) : working.forEach((a) => send({ type: "control", id: a.id, action: "stop" }))}>
              <Square data-icon="inline-start" /> Stop task
            </Button>
          )}
        </div>
    </header>
  );
}

// The tower: every agent of the task streaming side by side, with what needs
// you, the plan and findings in a rail beside them.
function LiveTask({ task, members }: { task: TaskView; members: AgentView[] }) {
  const missions = useTower((s) => s.missions);
  const incident = useTower((s) => s.incident);
  const mission = task.missionId ? missions.find((m) => m.id === task.missionId) : undefined;
  const n = members.length;
  const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
  const waiting = members.filter((a) => a.approval);
  const rail = waiting.length > 0 || task.needs.some((x) => x.type === "plan") || (mission && !mission.quick && mission.plan) || (task.kind === "incident" && incident);
  return (
    <article className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <TaskHeader task={task} />
      {task.kind === "incident" && incident && (
        <div className="border-b border-border px-4 py-3 [&>section]:shadow-none [&>section]:ring-0 [&>section]:p-0">
          <IncidentBar incident={incident} inline />
        </div>
      )}
      <div className="flex min-h-0 flex-1 gap-3 bg-background/60 p-3">
        <div
          className="grid min-h-0 flex-1 gap-3"
          style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${Math.ceil(n / cols)}, minmax(0, 1fr))` }}
        >
          {members.map((a) => (
            <LiveAgentCard key={a.id} agent={a} />
          ))}
        </div>
        {rail && (
          <aside className="flex min-h-0 w-80 shrink-0 flex-col gap-4 overflow-y-auto rounded-xl bg-card p-4 ring-1 ring-foreground/10 [scrollbar-width:thin]">
            {waiting.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-[11px] font-medium tracking-wide text-span-http uppercase">Needs you</h3>
                {waiting.map((a) => (
                  <ApprovalCard key={a.approval!.id} approval={a.approval!} label={agentName(a)} />
                ))}
              </div>
            )}
            {mission?.status === "awaiting_approval" && <ApprovalBar missionId={mission.id} />}
            {task.kind === "work" && (
              <div>
                <h3 className="mb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">You asked</h3>
                <p className="line-clamp-4 text-[13px] leading-snug">{task.request}</p>
              </div>
            )}
            {mission && !mission.quick && mission.plan && <CompactPlan mission={mission} members={members} />}
            {task.kind === "incident" && incident && (
              <div className="-mx-4 -mb-4 [&>section]:max-h-none [&>section]:border-t-0">
                <FindingsPanel incident={incident} />
              </div>
            )}
          </aside>
        )}
      </div>
    </article>
  );
}

// The plan as a checklist: each step, who has it, and whether that's done.
function CompactPlan({ mission, members }: { mission: NonNullable<ReturnType<typeof useTower.getState>["missions"][number]>; members: AgentView[] }) {
  const owner = (stepId: string) => mission.allocation?.workstreams.find((w) => w.stepIds.includes(stepId));
  return (
    <div>
      <h3 className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Plan · {mission.plan!.steps.length} steps</h3>
      <ol className="flex flex-col gap-1">
        {mission.plan!.steps.map((s) => {
          const w = owner(s.id);
          const worker = mission.workers.find((x) => x.name === w?.name);
          const agent = members.find((a) => a.id === worker?.agentId);
          const done = worker?.state === "done";
          return (
            <li key={s.id} className="flex items-start gap-2 text-[12.5px] leading-snug">
              <span className={cn("mt-1 size-2 shrink-0 rounded-full", done ? "bg-span-tool" : worker?.state === "running" ? "animate-pulse bg-span-retrieval" : "bg-muted-foreground/30")} />
              <span className={cn("min-w-0 flex-1", done && "text-muted-foreground line-through decoration-muted-foreground/40")}>{s.title}</span>
              {agent && <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">#{agent.id}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// One task as a story, top to bottom: what you asked, what needs you, the
// plan, the agents, the result, and (collapsed) everything that happened.
function TaskStory({ task }: { task: TaskView }) {
  const agents = useTower((s) => s.agents);
  const missions = useTower((s) => s.missions);
  const incident = useTower((s) => s.incident);
  const mission = task.missionId ? missions.find((m) => m.id === task.missionId) : undefined;
  const members = task.agentIds.flatMap((id) => agents.filter((a) => a.id === id));
  const failure = mission?.error || members.flatMap((agent) => agent.events)
    .filter((event) => event.kind === "error")
    .sort((a, b) => b.at - a.at)[0]?.text;

  return (
    <article className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <TaskHeader task={task} />

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-width:thin]">
        <div className="mx-auto flex max-w-4xl flex-col gap-6 px-4 py-5 sm:px-6">
          {task.kind === "incident" && incident && <IncidentBar incident={incident} />}

          {task.status === "ready" && (
            <div role="status" className="rounded-xl border border-span-tool/25 bg-span-tool/5 p-4 text-sm">
              <p className="font-medium">All agents have finished their current work.</p>
              <p className="mt-1 text-muted-foreground">{task.kind === "incident" ? "Review the findings and any remaining follow-ups. Mark done when you are ready to resolve the incident." : "Review the result below, then mark this task done. You can send a follow-up to an agent if something needs changing."}</p>
            </div>
          )}

          {task.kind === "work" && (task.status === "failed" || task.status === "stopped") && (
            <div role="status" className={cn("flex items-start gap-3 rounded-xl border p-4", task.status === "failed" ? "border-span-error/25 bg-span-error/5" : "border-border bg-secondary/50")}>
              <CircleAlert className={cn("mt-0.5 size-4 shrink-0", task.status === "failed" ? "text-span-error" : "text-muted-foreground")} />
              <div className="min-w-0 text-sm">
                <p className="font-medium">{task.status === "failed" ? "This task needs a review" : "Work is paused"}</p>
                <p className="mt-1 break-words text-muted-foreground">
                  {task.status === "failed"
                    ? failure || "An agent stopped before the task finished. Check its activity and any partial results below."
                    : mission?.status === "cancelled" ? "This task was cancelled. Review partial work below and start a new task to continue." : "Open an agent to review its progress and send a follow-up when you’re ready to continue."}
                </p>
              </div>
            </div>
          )}

          {/* What needs you comes first */}
          {(task.needs.some((n) => n.type === "approval") || mission?.status === "awaiting_approval") && (
            <Section title="Needs you" accent>
              <div className="flex flex-col gap-2">
                {members.filter((a) => a.approval).map((a) => (
                  <ApprovalCard key={a.approval!.id} approval={a.approval!} label={agentName(a)} />
                ))}
                {mission?.status === "awaiting_approval" && (
                  <p className="text-[13.5px]">The plan below is ready. Approve it and the planner decides how many agents to use.</p>
                )}
              </div>
            </Section>
          )}

          {task.kind === "work" && (
            <Section title="You asked">
              <p className="break-words text-[14px] leading-relaxed whitespace-pre-wrap">{task.request}</p>
              {task.files.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {task.files.map((f) => (
                    <span key={f} className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2 text-xs">
                      <FileText className="size-3.5 text-muted-foreground" /> {f}
                    </span>
                  ))}
                </div>
              )}
            </Section>
          )}

          {mission && !mission.quick && <PlanSection mission={mission} />}

          {members.length > 0 && (
            <Section title={task.kind === "incident" ? "Investigators" : "Agents"}>
              {mission && !mission.quick && mission.workers.length > 0 && (
                <div className="mb-3">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1 text-xs text-muted-foreground">
                    <span>{mission.workers.filter((worker) => worker.state === "done").length} of {mission.workers.length} workstreams finished</span>
                    {mission.status === "synthesizing" && <span className="text-span-workflow">Lead is combining the results</span>}
                    {mission.workers.some((worker) => worker.state === "waiting") && <span>{mission.workers.filter((worker) => worker.state === "waiting").length} waiting on earlier work</span>}
                  </div>
                  <progress className="task-progress h-1.5 w-full overflow-hidden rounded-full" value={mission.workers.filter((worker) => worker.state === "done").length} max={mission.workers.length} aria-label="Finished workstreams" />
                </div>
              )}
              <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                {members.map((a) => (
                  <AgentChip key={a.id} agent={a} />
                ))}
              </div>
            </Section>
          )}

          {task.kind === "incident" && incident && (
            <div className="-mx-4 rounded-xl ring-1 ring-foreground/10 [&>section]:max-h-none [&>section]:border-t-0">
              <FindingsPanel incident={incident} />
            </div>
          )}

          {task.kind === "work" && (task.result || task.resultAgentId) && (task.status === "ready" || task.status === "done" || task.status === "failed") && <ResultSection task={task} />}

          <ActivityLink task={task} members={members} />
        </div>
      </div>
    </article>
  );
}

function Section({ title, accent = false, children }: { title: string; accent?: boolean; children: React.ReactNode }) {
  return (
    <section className={cn(accent && "rounded-xl border border-span-http/40 bg-span-http/5 p-4")}>
      <h2 className={cn("mb-2 text-[12px] font-medium tracking-wide text-muted-foreground uppercase", accent && "text-span-http")}>{title}</h2>
      {children}
    </section>
  );
}

function PlanSection({ mission }: { mission: NonNullable<ReturnType<typeof useTower.getState>["missions"][number]> }) {
  const pending = mission.status === "awaiting_approval" || mission.status === "planning";
  const [open, setOpen] = useState(pending);
  if (mission.status === "planning")
    return (
      <Section title="Plan">
        <p className="text-sm text-muted-foreground">{mission.revisions.length ? "Revising the plan with your notes…" : "Reading the task and the inputs, outlining the steps…"}</p>
      </Section>
    );
  if (!mission.plan) return null;
  return (
    <Section title="Plan">
      <button className="mb-2 flex w-full items-center gap-2 text-left text-[13.5px]" onClick={() => setOpen(!open || pending)} aria-expanded={open || pending}>
        <span className="font-medium">{mission.plan.steps.length} steps</span>
        {mission.allocation && (
          <span className="text-muted-foreground">
            · {mission.allocation.workstreams.length} agent{mission.allocation.workstreams.length === 1 ? "" : "s"}
            {mission.allocation.synthesis ? " + lead" : ""}
          </span>
        )}
        {mission.status === "allocating" && <span className="text-muted-foreground">· deciding how many agents…</span>}
        {!pending && <ChevronDown className={cn("ml-auto size-4 text-muted-foreground transition-transform", open && "rotate-180")} />}
      </button>
      {(open || pending) && <PlanView mission={mission} />}
      {mission.status === "awaiting_approval" && <ApprovalBar missionId={mission.id} />}
      {mission.allocation && (open || pending) && <AllocationView mission={mission} />}
    </Section>
  );
}

function AgentChip({ agent }: { agent: AgentView }) {
  const setFocus = useTower((s) => s.setFocus);
  const send = useTower((s) => s.send);
  const connected = useTower((s) => s.connected);
  const now = useNow(250, !!agent.startsAt);
  const status = STATUS_STYLE[agent.status];
  return (
    <div className="flex min-w-0 items-start gap-3 rounded-lg border border-border px-3 py-2.5 transition-colors hover:bg-accent">
      <button className="flex min-w-0 flex-1 items-start gap-3 rounded text-left focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setFocus(agent.id)} aria-label={`Open ${agentName(agent)}`}>
        <span className="grid size-7 shrink-0 place-items-center rounded-md bg-secondary font-heading text-sm" title={`Say “${agent.id}” to address it`}>
          {agent.id}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-medium">{agentName(agent)}</span>
            <Dot className={cn("ml-auto", status.dot)} />
            <span className="shrink-0 text-[11.5px] text-muted-foreground">{agent.startsAt ? "starting" : status.label}</span>
          </span>
          <span className="mt-0.5 block truncate font-mono text-[11.5px] text-muted-foreground">{currentAction(agent)}</span>
        </span>
      </button>
      {agent.startsAt && (
        <Button size="xs" variant="outline" disabled={!connected} onClick={() => send({ type: "cancel_start", id: agent.id })}>
          Undo {Math.max(0, Math.ceil((agent.startsAt - now) / 1000))}s
        </Button>
      )}
    </div>
  );
}

function ResultSection({ task }: { task: TaskView }) {
  const agents = useTower((s) => s.agents);
  const setFocus = useTower((s) => s.setFocus);
  const resultAgent = agents.find((a) => a.id === task.resultAgentId);
  const outputQuery = useOutputs(resultAgent ?? ({ id: "", template: "coding", status: "idle" } as AgentView));
  const outputs = outputQuery.data ?? [];
  return (
    <Section title={task.status === "failed" ? "Where it ended" : "Result"}>
      <div className="rounded-xl border border-border p-4">
        {task.result && <Markdown className="text-[14px]">{task.result}</Markdown>}
        {!task.result && <p className="text-sm text-muted-foreground">{outputQuery.isLoading ? "Checking for deliverables…" : outputs.length ? "The agent’s deliverables are ready to review." : "No final summary was recorded. Open the agent to review its activity."}</p>}
        {outputQuery.isError && <p className="mt-2 text-sm text-span-error">Deliverables could not be loaded. <button className="underline underline-offset-2" onClick={() => void outputQuery.refetch()}>Try again</button></p>}
        {(outputs.length > 0 || task.branch) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            {task.branch && (
              <Pill>
                <GitBranch className="size-3" /> {task.branch}
              </Pill>
            )}
            {outputs.slice(0, 6).map((f) => (
              <button
                key={f.name}
                onClick={() => resultAgent && setFocus(resultAgent.id, f.name)}
                className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border bg-secondary/60 px-2 text-xs hover:bg-secondary"
              >
                <FileText className="size-3.5 text-muted-foreground" /> {f.name}
              </button>
            ))}
            {outputs.length > 6 && <span className="text-xs text-muted-foreground">+{outputs.length - 6} more</span>}
            {resultAgent && (
              <Button size="sm" className="ml-auto" onClick={() => setFocus(resultAgent.id)}>
                Review
              </Button>
            )}
          </div>
        )}
      </div>
    </Section>
  );
}

function ActivityLink({ task, members }: { task: TaskView; members: AgentView[] }) {
  const tools = members.reduce((n, a) => n + a.events.filter((e) => e.kind === "tool").length, 0);
  const steers = members.reduce((n, a) => n + a.events.filter((e) => e.kind === "steer").length, 0);
  if (!members.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4 text-[13px] text-muted-foreground">
      <Waypoints className="size-4 shrink-0" />
      <span>
        {tools} tool calls · {steers} instruction{steers === 1 ? "" : "s"} from you
      </span>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={() => navigate(task.missionId ? `/runs?task=${task.missionId}` : "/runs")}>
        Open activity and traces
      </Button>
    </div>
  );
}
