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

async function call<T extends z.ZodType>(schema: T, prompt: string, signal?: AbortSignal): Promise<{ data: z.infer<T>; costUsd: number }> {
  const res = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default", // retry on a fallback model if a safety classifier declines
    output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
    messages: [{ role: "user", content: prompt }],
  }, { signal, timeout: 120_000, maxRetries: 1 });
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
export async function planTask(c: PlanContext, revisions: string[], previous: Plan | null, signal?: AbortSignal) {
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
  const result = await call(PlanSchema, prompt, signal);
  validatePlan(result.data);
  return result;
}

// Step 2, after approval: decide how many agents, and which steps each takes.
export async function allocate(c: PlanContext, plan: Plan, signal?: AbortSignal) {
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
  const result = await call(AllocationSchema, prompt, signal);
  return { ...result, data: validateAllocation(result.data, plan) };
}

function validateGraph(graph: Map<string, string[]>, label: string): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (!graph.has(id)) throw new Error(`${label}: unknown dependency "${id}".`);
    if (visiting.has(id)) throw new Error(`${label}: dependency cycle at "${id}".`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id)!) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
}

export function validatePlan(plan: Plan): void {
  if (!plan.steps.length) throw new Error("The plan has no steps.");
  const graph = new Map(plan.steps.map((step) => [step.id, step.dependsOn]));
  if (graph.size !== plan.steps.length || plan.steps.some((step) => !step.id.trim())) throw new Error("Plan step IDs must be unique and nonempty.");
  validateGraph(graph, "Plan");
}

// Preserve the approved plan's dependencies instead of relying on the model
// to repeat them correctly in its workstream allocation.
export function validateAllocation(input: Allocation, plan: Plan): Allocation {
  validatePlan(plan);
  const a = structuredClone(input);
  if (!a.workstreams.length || a.workstreams.length > MAX_WORKERS) throw new Error(`Use between 1 and ${MAX_WORKERS} workstreams.`);
  const names = new Set(a.workstreams.map((stream) => stream.name));
  const paths = new Set(a.workstreams.map((stream) => stream.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "work"));
  if (names.size !== a.workstreams.length || paths.size !== names.size || a.workstreams.some((stream) => !stream.name.trim())) {
    throw new Error("Workstream names must be unique, including their output folder names.");
  }
  if (!a.synthesis && a.leadStepIds.length) throw new Error("Lead steps require a synthesis agent.");
  const lead = Symbol("lead");
  const owners = new Map<string, string | symbol>();
  const assign = (id: string, owner: string | symbol) => {
    if (!plan.steps.some((step) => step.id === id)) throw new Error(`Unknown plan step "${id}".`);
    if (owners.has(id)) throw new Error(`Plan step "${id}" is assigned more than once.`);
    owners.set(id, owner);
  };
  for (const id of a.leadStepIds) assign(id, lead);
  for (const stream of a.workstreams) {
    if (!stream.stepIds.length) throw new Error(`Workstream "${stream.name}" has no steps.`);
    for (const id of stream.stepIds) assign(id, stream.name);
  }
  for (const step of plan.steps) {
    const owner = owners.get(step.id);
    if (owner === undefined) throw new Error(`Plan step "${step.id}" has no owner.`);
    for (const dependency of step.dependsOn) {
      const prerequisite = owners.get(dependency);
      if (owner === lead || owner === prerequisite) continue;
      if (prerequisite === lead) throw new Error(`Step "${step.id}" depends on work reserved for the final lead.`);
      const stream = a.workstreams.find((candidate) => candidate.name === owner)!;
      if (!stream.after.includes(prerequisite as string)) stream.after.push(prerequisite as string);
    }
  }
  validateGraph(new Map(a.workstreams.map((stream) => [stream.name, stream.after])), "Workstreams");
  return a;
}
