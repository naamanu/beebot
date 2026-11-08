import { isRecovered } from "../../server/tasks.ts";
import type { AgentView, IncidentView } from "../../server/types.ts";

export type PlainStatus = { label: string; tone: "bad" | "waiting" | "recovering" | "good" };

export function hasUnconfirmedRecovery(incident: IncidentView): boolean {
  const skipped = incident.skippedInvestigation;
  return !!skipped && !skipped.recoveryConfirmed && skipped.demoRecoveryAt === undefined;
}

// The incident's state in plain words, from what is actually happening
// rather than a status someone has to set by hand.
export function plainIncidentStatus(incident: IncidentView, agents: AgentView[], fixProposed = false): PlainStatus {
  if (incident.status === "resolved" && incident.skippedInvestigation?.demoRecoveryAt !== undefined) return { label: "Resolved (demo reset)", tone: "good" };
  if (incident.status === "resolved") return hasUnconfirmedRecovery(incident)
    ? { label: "Closed with open questions", tone: "waiting" }
    : { label: "Resolved", tone: "good" };
  if (fixProposed || agents.some((a) => a.template === "incident" && a.approval)) return { label: "Fix waiting for you", tone: "waiting" };
  if (incident.fixAppliedAt !== null && isRecovered(incident)) return { label: "Back to normal", tone: "good" };
  if (incident.fixAppliedAt !== null) return { label: "Recovering", tone: "recovering" };
  if (incident.recommendation?.state === "reviewing") return { label: "Reviewing evidence", tone: "bad" };
  if (incident.recommendation?.state === "error") return { label: "Review needs a retry", tone: "waiting" };
  if (incident.recommendation?.decision?.action === "investigate") return { label: "More evidence needed", tone: "waiting" };
  return { label: "Investigating", tone: "bad" };
}
