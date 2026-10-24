import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { estimateCost } from "./pricing.ts";
import type { AgentView, IncidentAction, IncidentView, Intent, RouteVerdict } from "./types.ts";

// The decision engine. Every spoken turn is classified by N independent
// votes; the share of votes that agree is the confidence. High confidence
// acts immediately, low confidence asks the operator.

const INTENTS = ["assign", "stop", "correct", "approve", "rule", "incident", "chatter"] as const;
const INCIDENT_ACTIONS = ["none", "declare", "identified", "mitigated", "resolved"] as const;

export interface RouterContext {
  agents: AgentView[];
  rules: string[];
  recent: string[]; // previous utterances, oldest first
  pendingClarification: { utterance: string; question: string } | null;
  focused?: string | null; // agent the operator has open in the UI
  incident?: IncidentView | null;
  attachments?: string[]; // names of files attached to this instruction
}

export class Router {
  private client = new Anthropic();

  constructor(
    private model: string,
    private votes: number,
    private threshold = 0.6,
    // Ignoring needs stronger agreement than acting: silently dropping a real
    // instruction is worse than asking about it.
    private ignoreThreshold = 0.8,
  ) {}

  // One quick vote: what the command bar shows while you type.
  async preview(utterance: string, ctx: RouterContext): Promise<RouteVerdict> {
    return this.route(utterance, ctx, 1);
  }

  async route(utterance: string, ctx: RouterContext, votes = this.votes): Promise<RouteVerdict> {
    const started = Date.now();
    const targets: [string, ...string[]] = ["new", "all", "none", "unclear", ...ctx.agents.map((a) => a.id)];
    const schema = z.object({
      target: z.enum(targets).describe("Which agent the operator is addressing"),
      intent: z.enum(INTENTS),
      instruction: z
        .string()
        .describe("The instruction rewritten as a clear, self-contained directive for the agent. Empty for chatter."),
      incident_action: z.enum(INCIDENT_ACTIONS).describe('For intent "incident" only; otherwise "none".'),
    });

    const prompt = buildPrompt(utterance, ctx);
    const results = await Promise.allSettled(
      Array.from({ length: votes }, () =>
        this.client.messages.parse({
          model: this.model,
          max_tokens: 1024,
          output_config: { effort: "low", format: zodOutputFormat(schema) },
          messages: [{ role: "user", content: prompt }],
        }),
      ),
    );
    const usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      const u = r.value.usage;
      usage.inputTokens += u.input_tokens;
      usage.outputTokens += u.output_tokens;
      usage.costUsd += estimateCost(this.model, {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      });
    }
    const ballots = results.flatMap((r) => (r.status === "fulfilled" && r.value.parsed_output ? [r.value.parsed_output] : []));
    if (ballots.length === 0) {
      const reason = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
      throw new Error(`All router votes failed: ${reason?.reason?.message ?? "no parseable output"}`);
    }

    // Tally on (target, intent): that pair decides what happens.
    const tally = new Map<string, { target: string; intent: Intent; count: number; instruction: string }>();
    for (const b of ballots) {
      const key = `${b.target}|${b.intent}`;
      const row = tally.get(key) ?? { target: b.target, intent: b.intent, count: 0, instruction: b.instruction };
      row.count++;
      tally.set(key, row);
    }
    const ranked = [...tally.values()].sort((a, b) => b.count - a.count);
    const winner = ranked[0]!;
    const winningBallots = ballots.filter((b) => b.target === winner.target && b.intent === winner.intent);
    const incidentAction = mode(winningBallots.map((b) => b.incident_action)) as IncidentAction;
    const confidence = winner.count / ballots.length;

    const isNoop = winner.intent === "chatter" || winner.target === "none";
    const action: RouteVerdict["action"] =
      winner.target === "unclear"
        ? "clarify"
        : confidence >= (isNoop ? this.ignoreThreshold : this.threshold) ? (isNoop ? "ignored" : "applied") : "clarify";

    return {
      utterance,
      target: winner.target,
      intent: winner.intent,
      instruction: winner.instruction,
      incidentAction: winner.intent === "incident" ? incidentAction : "none",
      confidence,
      votes: ranked.map(({ target, intent, count }) => ({ target, intent, count })),
      action,
      ms: Date.now() - started,
      usage,
    };
  }
}

function mode<T>(xs: T[]): T {
  const counts = new Map<T, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

// A clarifying question built from the vote split itself, so it names the
// exact options the router was torn between.
export function clarifyingQuestion(v: RouteVerdict, agents: AgentView[]): string {
  const label = (t: string) =>
    t === "all" ? "all agents" : t === "none" ? "nobody" : t === "new" ? "a new agent" : `agent ${t}`;
  const [a, b] = v.votes;
  if (a?.target === "unclear") return "Which agent was that for, and what should it do?";
  const isNoop = (x: { target: string; intent: Intent }) => x.target === "none" || x.target === "unclear" || x.intent === "chatter";
  // Torn between "nobody" and an agent: ask about the agent.
  const real = v.votes.find((x) => !isNoop(x));
  if (a && b && (isNoop(a) || isNoop(b)) && real) return `Was that for ${label(real.target)}?`;
  if (a && b && a.target !== b.target) return `Did you mean ${label(a.target)} or ${label(b.target)}?`;
  if (a && b && a.intent !== b.intent) {
    const verb: Record<Intent, string> = {
      assign: "take this as a new task",
      incident: "update the incident",
      stop: "stop",
      correct: "change course",
      approve: "approve and ship",
      rule: "add a standing rule",
      chatter: "ignore that",
    };
    return `Should ${label(a.target)} ${verb[a.intent]}, or ${verb[b.intent]}?`;
  }
  const agent = agents.find((x) => x.id === v.target);
  return `Sorry, was that for ${agent ? label(agent.id) : "one of the agents"}?`;
}

function approvalsBlock(agents: AgentView[]): string {
  const waiting = agents.filter((a) => a.approval);
  if (!waiting.length) return "";
  return `\n<waiting_for_approval>\n${waiting.map((a) => `Agent ${a.id} wants to: ${a.approval!.summary}`).join("\n")}\nA bare "approve"/"yes"/"do it" with one agent waiting is for that agent.\n</waiting_for_approval>\n`;
}

function incidentBlock(incident: IncidentView | null | undefined): string {
  if (!incident) return "\nNo incident is active. Words like \"declare an incident\" or \"we have an outage\" start one.\n";
  return `\n<incident>Active ${incident.severity} incident "${incident.title}", status ${incident.status}.</incident>\n`;
}

function buildPrompt(utterance: string, ctx: RouterContext): string {
  const agents = ctx.agents
    .map((a) => {
      const recent = a.events
        .slice(-4)
        .map((e) => `    - ${e.kind}: ${e.text.slice(0, 160)}`)
        .join("\n");
      return `Agent ${a.id}${a.role ? ` [${a.role}]` : ""} (${a.status})\n  Task: ${a.task}\n  Recent activity:\n${recent || "    - (none yet)"}`;
    })
    .join("\n\n");

  return `You route a human operator's spoken words to the coding agents they are supervising. The text comes from live speech-to-text or a typed command bar, so expect transcription errors ("to" may be agent "two", "for" may be "four", "won" may be "one").

<agents>
${agents || "(no agents yet: anything that sounds like work to do is an assign to a new agent)"}
</agents>
${ctx.focused ? `\nThe operator has agent ${ctx.focused} open full-screen. An instruction that names no agent is for agent ${ctx.focused}.\n` : ""}${approvalsBlock(ctx.agents)}${incidentBlock(ctx.incident)}${
  ctx.attachments?.length
    ? `\nThe operator attached files to this instruction: ${ctx.attachments.join(", ")}. Starting work on them is an assign (target "new" unless they name an agent).\n`
    : ""
}
<standing_rules>
${ctx.rules.length ? ctx.rules.map((r) => `- ${r}`).join("\n") : "(none)"}
</standing_rules>

<recent_utterances>
${ctx.recent.length ? ctx.recent.map((u) => `- "${u}"`).join("\n") : "(none)"}
</recent_utterances>
${
  ctx.pendingClarification
    ? `
<pending_clarification>
The operator said "${ctx.pendingClarification.utterance}" and you asked: "${ctx.pendingClarification.question}"
The new utterance is probably the answer. If so, route the ORIGINAL request using the answer.
</pending_clarification>
`
    : ""
}
Decide:
- target: the agent being addressed. Resolve by number, or by what they are working on ("whoever is on auth"). Use "new" for work that should go to a new agent. Use "all" for instructions to everyone. Use "none" if no agent is addressed.
- intent:
  - assign: a new piece of work. Target "new" when the operator asks for a new agent or someone to take it on ("new agent: …", "spin someone up to…", "can someone…", "new task: …" with no agent named), or when there are no agents. Target a specific agent when they hand it its next task ("agent two, next task: …", "once you're done, three, do…"). The instruction is the complete task description.
  - stop: halt / pause the agent. Also: saying no to an agent that is waiting for approval ("no", "don't", "hold off").
  - correct: change what it is doing, or give it new information.
  - approve: the work is good, ship it. Also: saying yes to an agent that is waiting for approval ("approve", "do it", "go ahead", "yes, roll it back").
  - rule: a lasting constraint that should apply to every agent from now on ("never…", "always…", "no new dependencies"). Rules always target "all".
  - incident: about the incident itself, not one agent. Target "all". Set incident_action: "declare" to start an incident (instruction = a short title, e.g. "Checkout failing"), or "identified", "mitigated", "resolved" when the commander states that status.
  - chatter: talking to someone else, thinking aloud, or filler. Never use chatter for something phrased as an instruction to an agent ("make it…", "change that…").
- If it is an instruction but you cannot tell which agent it is for, or what it asks for, set target to "unclear". Do not guess: the operator will be asked. Before choosing "unclear", check for a spoken agent number, including mis-transcriptions: a leading "to"/"too" is agent two, "for" is four, "won" is one, "tree"/"free" is three. "to stop" means "two, stop".
- instruction: a clear directive the agent can act on without hearing the original speech.

Operator just said: "${utterance}"`;
}
