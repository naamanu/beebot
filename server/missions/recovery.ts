import type { AgentSnapshot } from "../agents.ts";
import type { AgentView, MissionView } from "../types.ts";
import { areMissionAgentsFinished } from "../tasks.ts";

// Older sessions could save a successful result while still labelled working:
// SDK idle events were not enabled. Keep the result reviewable after restart.
export function recoverAgent(snapshot: AgentSnapshot): AgentSnapshot {
  if (!["working", "starting", "blocked"].includes(snapshot.status)) return snapshot;
  const hasFinalResult = snapshot.status === "working" && !snapshot.runId
    && !snapshot.pendingMessages && snapshot.events.at(-1)?.kind === "result";
  return { ...snapshot, status: hasFinalResult ? "idle" : "paused", events: [...snapshot.events, {
    at: Date.now(), kind: "steer", text: hasFinalResult
      ? "Server restarted after a successful result. Review the finished work."
      : "Server restarted. Review partial work before continuing this task.",
  }] };
}

export function recoverMission(mission: MissionView, agents: AgentView[]): MissionView {
  if (["done", "cancelled", "failed"].includes(mission.status)) return mission;
  const members = agents.filter((agent) => agent.missionId === mission.id);
  const finished = new Set(members.filter((agent) => agent.status === "idle").map((agent) => agent.id));
  const candidate: MissionView = { ...mission, workers: mission.workers.map((worker) =>
    worker.agentId && finished.has(worker.agentId) ? { ...worker, state: "done" } : worker,
  ) };
  if (["running", "synthesizing", "ready"].includes(mission.status) && areMissionAgentsFinished(candidate, members)) {
    return { ...candidate, status: "ready", endedAt: null, error: null };
  }
  return { ...mission, status: "failed", endedAt: mission.endedAt ?? Date.now(), error: "The server restarted before this task finished." };
}
