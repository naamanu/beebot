import Anthropic from "@anthropic-ai/sdk";
import type { RunRow } from "../types.ts";
import type { Incident } from "./incident.ts";
import type { JamieMeeting } from "./jamie.ts";

const client = new Anthropic();
const iso = (t: number) => new Date(t).toISOString().slice(11, 19) + "Z";

// A blameless postmortem written from what actually happened: the incident
// timeline, the agents' runs, and (if available) the call notes from Jamie.
export async function writePostmortem(incident: Incident, runs: RunRow[], call: JamieMeeting | null): Promise<string> {
  const v = incident.view();
  const timeline = v.timeline.map((e) => `${iso(e.at)}  [${e.kind}] ${e.by}: ${e.text}`).join("\n");
  const deploys = incident.sim.deploys.map((d) => `#${d.id} ${iso(d.at)} ${d.service} by ${d.author}: ${d.message}${d.rolledBackAt ? ` (rolled back ${iso(d.rolledBackAt)})` : ""}`).join("\n");
  const agentRuns = runs
    .map((r) => `agent-${r.agentId} ${r.status} ${iso(r.startedAt)}-${r.endedAt ? iso(r.endedAt) : "…"}: ${r.task}\n  result: ${(r.result ?? "").slice(0, 600)}`)
    .join("\n");
  const callNotes = call
    ? `<call_notes source="Jamie" title="${call.title}">\n${call.summary.markdown}\n\nAction items from the call:\n${call.tasks.map((t) => `- ${t.content}${t.assignee?.name ? ` (${t.assignee.name})` : ""}`).join("\n")}\n</call_notes>`
    : "<call_notes>none recorded</call_notes>";

  const prompt = `Write a blameless incident postmortem in Markdown from the records below. Use only facts in the records; where something is unknown, say so rather than guessing.

Sections, in order:
# <title>
**Severity** · **Duration** (impact start to mitigation) · **Status**
## Summary (3 sentences)
## Impact (who/what was affected, for how long, peak error rate)
## Timeline (UTC; a table with Time | Event | Who; include detection, key findings, approvals, mitigation, status posts)
## Root cause
## How we found it (which investigations mattered, which leads were ruled out)
## What went well / What was hard
## Action items (a table with Action | Owner | Priority; owners from the call notes where given, otherwise "unassigned")

<incident title="${v.title}" severity="${v.severity}" status="${v.status}" impact_start="${iso(v.impactAt)}" declared="${iso(v.declaredAt)}" mitigated="${v.mitigatedAt ? iso(v.mitigatedAt) : "not yet"}">
Peak checkout error rate in the last 15 minutes: ${Math.max(...v.errorRate.map((p) => p.v)).toFixed(1)}%. Current: ${v.errorRate.at(-1)?.v.toFixed(1)}%.
</incident>

<timeline>
${timeline}
</timeline>

<deploys>
${deploys}
</deploys>

<agent_runs>
${agentRuns}
</agent_runs>

<status_page>
${v.statusPosts.map((p) => `${iso(p.at)} [${p.status}] ${p.message}`).join("\n") || "no posts"}
</status_page>

${callNotes}`;

  const message = await client.beta.messages
    .stream({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // retry on a fallback model if a safety classifier declines
      output_config: { effort: "medium" },
      messages: [{ role: "user", content: prompt }],
    })
    .finalMessage();

  if (message.stop_reason === "refusal") throw new Error("The model declined to write this postmortem.");
  return message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
}
