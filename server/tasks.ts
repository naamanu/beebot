import type { AgentView, IncidentView, MissionView, TaskNeed, TaskStatus, TaskView } from "./types.ts";

// The UI is organised around tasks: everything the operator asked for.
// A task owns its agents. An agent without a task never becomes a task itself.
export function buildTasks(agents: AgentView[], missions: MissionView[], incident: IncidentView | null): TaskView[] {
  const tasks: TaskView[] = [];
  const byId = new Map(agents.map((a) => [a.id, a]));

  if (incident) {
    const members = agents.filter((a) => a.template === "incident");
    const needs = approvals(members);
    // Ready once no investigator is still active (idle or stopped both count).
    const active = members.some((a) => a.status === "working" || a.status === "starting" || a.status === "blocked" || !!a.startsAt);
    const ready = members.length > 0 && !active;
    const recovered = isRecovered(incident);
    const status: TaskStatus = incident.status === "resolved" ? "done" : needs.length ? "needs_you" : ready ? "ready" : "working";
    if (status === "ready")
      needs.push({
        type: "completion",
        label: recovered ? "Errors are back to normal: resolve it?" : incident.fixAppliedAt === null ? "Investigators finished: a fix is waiting for you" : "Recovering: watch the errors come down",
      });
    tasks.push({
      id: incident.id,
      kind: "incident",
      title: incident.title,
      request: incident.title,
      template: "incident",
      files: [],
      status,
      needs,
      createdAt: incident.declaredAt,
      endedAt: incident.status === "resolved" ? (incident.timeline.at(-1)?.at ?? null) : null,
      missionId: null,
      agentIds: members.map((a) => a.id),
      resultAgentId: null,
      result: null,
      branch: null,
      costUsd: members.reduce((s, a) => s + a.costUsd, 0),
      followUp: false,
    });
  }

  for (const m of missions) {
    const ids = [...new Set([...m.workers.flatMap((w) => (w.agentId ? [w.agentId] : [])), ...(m.leadAgentId ? [m.leadAgentId] : []), ...agents.filter((a) => a.missionId === m.id).map((a) => a.id)])];
    const members = ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    const needs: TaskNeed[] = [...(m.status === "awaiting_approval" ? [{ type: "plan" as const, label: "Approve the plan" }] : []), ...approvals(members)];
    const status = missionStatus(m, members, needs);
    if (status === "ready") needs.push({ type: "completion", label: "Review result and mark done" });
    // The lead stands for the task when there is one; otherwise the last agent to finish.
    const resultAgent = (m.leadAgentId && byId.get(m.leadAgentId)) || [...members].sort((a, b) => lastResultAt(b) - lastResultAt(a))[0];
    tasks.push({
      id: m.id,
      kind: "work",
      title: m.title || m.request.slice(0, 70),
      request: m.request,
      template: m.template,
      files: m.files,
      status,
      needs,
      createdAt: m.createdAt,
      endedAt: m.endedAt ?? null,
      missionId: m.id,
      agentIds: ids,
      resultAgentId: resultAgent?.id ?? null,
      result: status === "ready" || status === "done" || status === "failed" ? lastResult(resultAgent) : null,
      branch: m.template === "coding" && resultAgent && /ready|done|failed/.test(status) ? `agent-${resultAgent.id}` : null,
      costUsd: m.costUsd + members.reduce((s, a) => s + a.costUsd, 0),
      followUp: m.followUp ?? false,
    });
  }

  // Needs you first, then working, then finished; newest first within each.
  const rank: Record<TaskStatus, number> = { needs_you: 0, ready: 0, planning: 1, working: 1, failed: 2, stopped: 2, done: 3 };
  return tasks.sort((x, y) => rank[x.status] - rank[y.status] || y.createdAt - x.createdAt);
}

// Checkout errors back near the 0.4% baseline for the last few samples.
export function isRecovered(incident: IncidentView): boolean {
  const recent = incident.errorRate.slice(-4);
  return recent.length > 0 && recent.every((p) => p.v < 1);
}

function approvals(agents: AgentView[]): TaskNeed[] {
  return agents.flatMap((a) =>
    a.approval ? [{ type: "approval" as const, label: a.approval.summary, agentId: a.id, approvalId: a.approval.id }] : [],
  );
}

function missionStatus(m: MissionView, members: AgentView[], needs: TaskNeed[]): TaskStatus {
  if (m.status === "cancelled") return "stopped";
  if (needs.length) return "needs_you";
  if (m.status === "planning" || m.status === "allocating") return "planning";
  if (m.status === "done") return "done";
  if (m.status === "failed") return "failed";
  if (m.status === "ready") {
    if (areMissionAgentsFinished(m, members)) return "ready";
    if (members.some((agent) => agent.status === "error")) return "failed";
    if (members.some((agent) => agent.status === "paused")) return "stopped";
    return "working";
  }
  if (members.some((a) => a.status === "working" || a.status === "starting" || a.startsAt)) return "working";
  if (members.length && members.every((a) => a.status === "paused")) return "stopped";
  return "working";
}

export function isAgentFinished(agent: AgentView): boolean {
  return agent.status === "idle" && !agent.approval && !agent.startsAt;
}

export function areMissionAgentsFinished(mission: MissionView, members: AgentView[]): boolean {
  const byId = new Map(members.map((agent) => [agent.id, agent]));
  const finished = (id: string | null) => !!id && !!byId.get(id) && isAgentFinished(byId.get(id)!);
  return mission.workers.length > 0
    && mission.workers.every((worker) => worker.state === "done" && finished(worker.agentId))
    && (!mission.allocation?.synthesis || !!mission.leadAgentId)
    && (!mission.leadAgentId || finished(mission.leadAgentId))
    && members.every(isAgentFinished);
}

function lastResult(a: AgentView | undefined): string | null {
  return a?.events.findLast((e) => e.kind === "result")?.text ?? null;
}

function lastResultAt(a: AgentView): number {
  return a.events.findLast((e) => e.kind === "result")?.at ?? 0;
}

