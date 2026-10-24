import { isRecovered } from "../../server/tasks.ts";
import type { AgentView, IncidentView } from "../../server/types.ts";

export type PlainStatus = { label: string; tone: "bad" | "waiting" | "recovering" | "good" };

// The incident's state in plain words, from what is actually happening
// rather than a status someone has to set by hand.
export function plainIncidentStatus(incident: IncidentView, agents: AgentView[], fixProposed = false): PlainStatus {
  if (incident.status === "resolved") return { label: "Resolved", tone: "good" };
  if (fixProposed || agents.some((a) => a.template === "incident" && a.approval)) return { label: "Fix waiting for you", tone: "waiting" };
  if (incident.fixAppliedAt !== null && isRecovered(incident)) return { label: "Back to normal", tone: "good" };
  if (incident.fixAppliedAt !== null) return { label: "Recovering", tone: "recovering" };
  return { label: "Investigating", tone: "bad" };
}
