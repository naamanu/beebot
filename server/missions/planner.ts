import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { estimateCost } from "../pricing.ts";
import type { Allocation, Plan } from "../types.ts";

const client = new Anthropic();
const MODEL = "claude-opus-5-5";
export const MAX_WORKERS = 4;

const PlanSchema = z.object({
  summary: z.string().describe("What the task is really asking for, in one or two sentences."),
  steps: z
    .array(
      z.object({
        id: z.string().describe('"S1", "S2", … in order'),
        title: z.string().describe("Short imperative, under 8 words"),
        detail: z.string().describe("One or two sentences: what to do and what it produces"),
        dependsOn: z.array(z.string()).describe("Ids of steps whose results this step needs"),
      }),
    )
    .describe("3 to 8 concrete steps. Fewer for small tasks."),
  risks: z.array(z.string()).describe("Ambiguities or things that could go wrong; empty if none"),
});

const AllocationSchema = z.object({
  reasoning: z.string().describe("Two or three sentences on why this many agents."),
  workstreams: z.array(
    z.object({
      name: z.string().describe("2 to 3 words, e.g. “Data prep”"),
      stepIds: z.array(z.string()),
      after: z.array(z.string()).describe("Names of other workstreams whose outputs this one needs before it can start"),
      rationale: z.string().describe("One sentence"),
    }),
  ),
  synthesis: z.boolean().describe("True if a lead should combine the workstreams' results at the end"),
  leadStepIds: z.array(z.string()).describe("With synthesis: the final combining steps (merge, integrate, final write-up) the lead does. Otherwise empty."),
});

export interface PlanContext {
  template: "general" | "coding";
  request: string;
  files: { name: string; size: number; head: string | null }[];
  repoFiles: string[];
}

function contextBlock(c: PlanContext): string {
  const files = c.files.length
    ? `<attached_files>\n${c.files
        .map((f) => `<file name="${f.name}" size="${f.size} bytes">${f.head ? `\n${f.head}\n` : " (binary or too large to preview)"}</file>`)
        .join("\n")}\n</attached_files>`
    : "";
  const repo = c.template === "coding" ? `<repository files="${c.repoFiles.length}">\n${c.repoFiles.join("\n")}\n</repository>` : "";
  return [files, repo].filter(Boolean).join("\n\n");
}

async function call<T extends z.ZodType>(schema: T, prompt: string): Promise<{ data: z.infer<T>; costUsd: number }> {
  const res = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // retry on a fallback model if a safety classifier declines
    output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
    messages: [{ role: "user", content: prompt }],
  });
  if (res.stop_reason === "refusal") throw new Error("The planner declined this task.");
  if (!res.parsed_output) throw new Error("The planner returned no plan.");
  const u = res.usage;
  const costUsd = estimateCost(res.model, {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  });
  return { data: res.parsed_output as z.infer<T>, costUsd };
}

// Step 1: understand the task and outline the steps. No agent count yet.
export async function planTask(c: PlanContext, revisions: string[], previous: Plan | null) {
  const kind =
    c.template === "coding"
      ? "a coding task on the repository below; each agent would work in its own git worktree of it"
      : "a general task (analysis, research, writing) on the attached files; agents run Python via uv and write deliverables to an outputs folder";
  const revise = previous
    ? `\n\n<previous_plan>\n${JSON.stringify(previous, null, 2)}\n</previous_plan>\n<operator_feedback>\n${revisions.map((r) => `- ${r}`).join("\n")}\n</operator_feedback>\nRevise the plan to address the feedback. Keep what they didn't object to.`
    : "";
  const prompt = `You are planning ${kind}. A human operator will review your plan before any agent starts.

Analyze what is actually being asked, then outline the steps to do it well. File previews show only the first lines of each file: never draw conclusions about the data from them (e.g. that something is missing or absent); plan steps that check it. Make each step concrete and checkable, and mark real data dependencies between steps (a step depends on another only if it needs that step's result). Do not decide how many agents to use yet.

${contextBlock(c)}

<task>
${c.request}
</task>${revise}`;
  return call(PlanSchema, prompt);
}

// Step 2, after approval: decide how many agents, and which steps each takes.
export async function allocate(c: PlanContext, plan: Plan) {
  const coding =
    c.template === "coding"
      ? "Coding agents work in separate git worktrees, so parallel workstreams must touch different files or their branches will conflict; the lead merges the branches and runs the tests."
      : "Agents share nothing but files: a workstream that needs another's results gets that workstream's outputs folder when it starts.";
  const prompt = `An operator approved this plan. Decide how many agents should carry it out, from 1 to ${MAX_WORKERS}.

Rules:
- Every agent costs money and coordination. Use one agent when the steps are sequential or small. Add agents only for genuinely independent chunks of work that are each substantial.
- Keep dependent steps in the same workstream where possible. Use "after" only when one workstream truly needs another's results.
- ${coding}
- Set synthesis to true only when there are two or more workstreams whose results must be combined into one deliverable. Then give the final combining steps (merge, integrate, run the full suite, final write-up) to the lead via leadStepIds, not to a workstream.
- Every step id must appear exactly once: in one workstream, or in leadStepIds.

<task>${c.request}</task>

<approved_plan>
${JSON.stringify(plan, null, 2)}
</approved_plan>`;
  const result = await call(AllocationSchema, prompt);
  return { ...result, data: normalize(result.data, plan) };
}

// Guard against a malformed allocation: cap the count, cover every step once,
// drop unknown "after" names and self-dependencies.
function normalize(a: Allocation, plan: Plan): Allocation {
  let workstreams = a.workstreams.filter((w) => w.stepIds.length).slice(0, MAX_WORKERS);
  if (!workstreams.length) workstreams = [{ name: "Main", stepIds: [], after: [], rationale: "Single agent." }];
  const synthesis = a.synthesis && workstreams.length > 1;
  const leadStepIds = synthesis ? a.leadStepIds.filter((id) => plan.steps.some((s) => s.id === id)) : [];
  const seen = new Set<string>(leadStepIds);
  for (const w of workstreams) w.stepIds = w.stepIds.filter((id) => plan.steps.some((s) => s.id === id) && !seen.has(id) && seen.add(id));
  const missing = plan.steps.filter((s) => !seen.has(s.id)).map((s) => s.id);
  workstreams[workstreams.length - 1]!.stepIds.push(...missing);
  const names = new Set(workstreams.map((w) => w.name));
  for (const w of workstreams) w.after = w.after.filter((n) => n !== w.name && names.has(n));
  return { reasoning: a.reasoning, workstreams, synthesis, leadStepIds };
}
