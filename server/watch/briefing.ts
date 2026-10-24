import type { AgentView, IncidentView } from "../types.ts";

export interface BriefingState {
  errorRate: number;
  findings: number;
  actions: number;
  waiting: number;
}

export function briefingState(incident: IncidentView, agents: AgentView[]): BriefingState {
  return {
    errorRate: incident.errorRate.at(-1)?.v ?? 0,
    findings: incident.findings.length,
    actions: incident.timeline.filter((e) => e.kind === "action" || e.kind === "statuspage").length,
    waiting: agents.filter((a) => a.template === "incident" && a.approval).length,
  };
}

// A short spoken update during an incident, or null when nothing worth
// saying has changed since the last one.
export function incidentBriefing(incident: IncidentView, agents: AgentView[], previous: BriefingState | null): { text: string; state: BriefingState } | null {
  const now = briefingState(incident, agents);
  if (previous) {
    const moved = Math.abs(now.errorRate - previous.errorRate) >= 3;
    const news = now.findings > previous.findings || now.actions > previous.actions || now.waiting !== previous.waiting;
    if (!moved && !news) return null;
  }
  const parts: string[] = [];
  // Trend from the last ~30 seconds of the curve, not from the last briefing:
  // errors can rise and fall again between two briefings.
  const recent = incident.errorRate.slice(-3);
  const slope = recent.length >= 2 ? recent.at(-1)!.v - recent[0]!.v : 0;
  const trend = slope < -1 ? ", falling" : slope > 1 ? ", rising" : "";
  parts.push(`checkout errors at ${now.errorRate.toFixed(now.errorRate < 10 ? 1 : 0)} percent${trend}`);
  const newFindings = now.findings - (previous?.findings ?? 0);
  if (newFindings > 0) parts.push(`${newFindings} new finding${newFindings === 1 ? "" : "s"}`);
  const lastAction = incident.timeline.filter((e) => e.kind === "action").at(-1);
  if (lastAction && now.actions > (previous?.actions ?? 0)) parts.push(lastAction.text.split(".")[0]!.toLowerCase());
  if (now.waiting) parts.push(`${now.waiting} action${now.waiting === 1 ? "" : "s"} waiting for your approval`);
  return { text: `Update: ${parts.join("; ")}.`, state: now };
}

// The last word when an incident closes.
export function closingBriefing(incident: IncidentView): string {
  const minutes = Math.max(1, Math.round(((incident.mitigatedAt ?? Date.now()) - incident.impactAt) / 60_000));
  const posts = incident.statusPosts.length;
  return `Incident closed. Customers were affected for about ${minutes} minute${minutes === 1 ? "" : "s"}; ${incident.findings.length} findings recorded${posts ? ` and ${posts} status update${posts === 1 ? "" : "s"} posted` : ""}. The postmortem is ready to generate.`;
}
