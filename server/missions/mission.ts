import { randomUUID } from "node:crypto";
import type { Allocation, MissionStatus, MissionView, Plan, Workstream } from "../types.ts";
import { allocate, planTask, type PlanContext } from "./planner.ts";

export interface SpawnRequest {
  role: string | undefined; // undefined for a quick task's single agent
  undo?: boolean; // wait out the undo window before starting
  title: string; // short, for the agent's card
  task: string;
  // General: copy these agents' outputs/ into inputs/<as>/. Coding: unused.
  inputsFrom: { agentId: string; as: string }[];
  // Coding: inherit every prerequisite branch before starting the agent.
  baseAgentIds: string[];
}

export interface MissionHooks {
  spawn: (mission: Mission, req: SpawnRequest) => string; // returns the new agent id
  changed: () => void;
  speak: (text: string) => void;
  stop?: (agentId: string, reason: string) => void;
}

type WorkerState = "waiting" | "running" | "done" | "error";

// One task, planned before it runs:
// planning → awaiting_approval → allocating → running → (synthesizing) → ready → done
export class Mission {
  readonly id = randomUUID().slice(0, 8);
  readonly createdAt = Date.now();
  status: MissionStatus = "planning";
  plan: Plan | null = null;
  revisions: string[] = [];
  allocation: Allocation | null = null;
  workers: { stream: Workstream; agentId: string | null; state: WorkerState }[] = [];
  leadAgentId: string | null = null;
  leadState: WorkerState = "waiting";
  costUsd = 0;
  error: string | null = null;
  endedAt: number | null = null;
  quick = false;
  title: string;
  private operation: AbortController | null = null;

  constructor(
    private ctx: PlanContext,
    private hooks: MissionHooks,
  ) {
    this.title = fallbackTitle(ctx.request);
  }

  setTitle(title: string): void {
    this.title = title;
    this.hooks.changed();
  }

  // No plan: one agent starts right away (after the undo window).
  startQuick(): void {
    if (this.status !== "planning" || this.operation) return;
    this.quick = true;
    this.allocation = { reasoning: "", workstreams: [], synthesis: false, leadStepIds: [] };
    const stream: Workstream = { name: "Agent", stepIds: [], after: [], rationale: "" };
    this.workers = [{ stream, agentId: null, state: "running" }];
    this.set("running");
    try {
      this.workers[0]!.agentId = this.hooks.spawn(this, { role: undefined, title: this.title, task: this.ctx.request, inputsFrom: [], baseAgentIds: [], undo: true });
    } catch (err) {
      this.fail(err);
    }
    this.hooks.changed();
  }

  get template() {
    return this.ctx.template;
  }

  view(): MissionView {
    return {
      id: this.id,
      title: this.title,
      quick: this.quick,
      request: this.ctx.request,
      template: this.ctx.template,
      files: this.ctx.files.map((f) => f.name),
      status: this.status,
      plan: this.plan,
      revisions: this.revisions,
      allocation: this.allocation,
      workers: this.workers.map((w) => ({ name: w.stream.name, agentId: w.agentId, state: w.state })),
      leadAgentId: this.leadAgentId,
      costUsd: this.costUsd,
      createdAt: this.createdAt,
      endedAt: this.endedAt,
      error: this.error,
    };
  }

  // --- phases ---

  async start(): Promise<void> {
    if (this.status !== "planning" || this.operation) return;
    await this.makePlan();
  }

  async revise(note: string): Promise<void> {
    if (this.status !== "awaiting_approval") return;
    this.revisions.push(note);
    await this.makePlan();
  }

  async approve(): Promise<void> {
    if (this.status !== "awaiting_approval" || !this.plan) return;
    const operation = this.newOperation();
    this.set("allocating");
    try {
      const { data, costUsd } = await allocate(this.ctx, this.plan, operation.signal);
      if (!this.isCurrent(operation)) return;
      this.costUsd += costUsd;
      this.allocation = data;
      this.workers = data.workstreams.map((stream) => ({ stream, agentId: null, state: "waiting" as const }));
      const n = data.workstreams.length;
      this.hooks.speak(`Plan approved. Using ${n} agent${n === 1 ? "" : "s"}${data.synthesis ? " and a lead to combine their work" : ""}.`);
      this.set("running");
      this.startRunnable();
    } catch (err) {
      if (this.isCurrent(operation)) this.fail(err);
    } finally {
      if (this.operation === operation) this.operation = null;
    }
  }

  cancel(): void {
    if (this.terminal) return;
    this.operation?.abort();
    this.set("cancelled");
    this.stopActive("Task cancelled");
  }

  complete(): boolean {
    if (this.status !== "ready") return false;
    this.set("done");
    return true;
  }

  // Called when an agent of this mission reports a result.
  onAgentFinished(agentId: string, ok: boolean): void {
    if (this.status !== "running" && this.status !== "synthesizing") return;
    if (agentId === this.leadAgentId) {
      if (this.leadState !== "running") return;
      this.leadState = ok ? "done" : "error";
      if (ok) this.set("ready");
      else this.fail(new Error("The lead failed to combine the results."));
      this.hooks.speak(ok ? "The lead has combined the results. Ready for your review." : "The lead hit an error.");
      return;
    }
    const w = this.workers.find((x) => x.agentId === agentId);
    if (!w || w.state !== "running") return;
    w.state = ok ? "done" : "error";
    if (!ok) {
      this.fail(new Error(`Workstream "${w.stream.name}" failed. Dependent work was not started.`));
      return;
    }
    this.startRunnable();
  }

  // --- internals ---

  private async makePlan(): Promise<void> {
    const operation = this.newOperation();
    this.set("planning");
    try {
      const { data, costUsd } = await planTask(this.ctx, this.revisions, this.plan, operation.signal);
      if (!this.isCurrent(operation)) return;
      this.costUsd += costUsd;
      this.plan = data;
      this.set("awaiting_approval");
      this.hooks.speak(`Plan ready: ${data.steps.length} steps. Approve it, or tell me what to change.`);
    } catch (err) {
      if (this.isCurrent(operation)) this.fail(err);
    } finally {
      if (this.operation === operation) this.operation = null;
    }
  }

  // Start every waiting workstream whose dependencies are finished; when all
  // are finished, hand over to the lead (or finish).
  private startRunnable(): void {
    if (this.status !== "running") return;
    const finished = (name: string) => this.workers.find((w) => w.stream.name === name)?.state === "done";
    const ready = this.workers.filter((w) => w.state === "waiting" && w.stream.after.every(finished));
    const running = this.workers.some((w) => w.state === "running");
    if (!ready.length && !running && this.workers.some((w) => w.state === "waiting")) {
      this.fail(new Error("No workstream can start: its prerequisites are incomplete."));
      return;
    }
    for (const w of ready) {
      w.state = "running";
      try {
        w.agentId = this.hooks.spawn(this, {
          role: w.stream.name,
          title: this.plan!.steps.filter((s) => w.stream.stepIds.includes(s.id)).map((s) => `${s.id} ${s.title}`).join(" · "),
          task: this.workerTask(w.stream),
          inputsFrom: w.stream.after.flatMap((n) => {
            const dep = this.workers.find((x) => x.stream.name === n);
            return dep?.agentId ? [{ agentId: dep.agentId, as: `from-${slug(n)}` }] : [];
          }),
          baseAgentIds: w.stream.after.flatMap((name) => {
            const dependency = this.workers.find((candidate) => candidate.stream.name === name);
            return dependency?.agentId ? [dependency.agentId] : [];
          }),
        });
      } catch (err) {
        w.state = "error";
        this.fail(err);
        return;
      }
    }
    this.hooks.changed();
    if (this.workers.every((w) => w.state === "done")) this.finishWorkstreams();
  }

  private finishWorkstreams(): void {
    if (this.allocation?.synthesis && !this.leadAgentId) {
      this.set("synthesizing");
      this.leadState = "running";
      try {
        this.leadAgentId = this.hooks.spawn(this, {
          role: "Lead",
          title: `Combine ${this.workers.length} workstreams${this.allocation?.leadStepIds.length ? ` · ${this.allocation.leadStepIds.join(" ")}` : ""}`,
          task: this.leadTask(),
          inputsFrom: this.workers.flatMap((w) => (w.agentId ? [{ agentId: w.agentId, as: `workers/${slug(w.stream.name)}` }] : [])),
          baseAgentIds: [],
        });
      } catch (err) {
        this.leadState = "error";
        this.fail(err);
        return;
      }
      this.hooks.changed();
    } else if (!this.leadAgentId) {
      const failed = this.workers.some((w) => w.state === "error");
      this.set(failed ? "failed" : "ready");
      this.hooks.speak(failed ? "The task finished with errors." : "All workstreams are done. Review the result and mark the task done.");
    }
  }

  private workerTask(stream: Workstream): string {
    const plan = this.plan!;
    const mine = plan.steps.filter((s) => stream.stepIds.includes(s.id));
    const others = this.workers.filter((w) => w.stream !== stream);
    const coding = this.ctx.template === "coding";
    const deps = stream.after.length
      ? coding
        ? `\nYour branch already includes the commits from these prerequisite workstreams: ${stream.after.map((name) => `"${name}"`).join(", ")}.`
        : `\nResults from ${stream.after.map((n) => `"${n}"`).join(", ")} are in ${stream.after.map((n) => `inputs/from-${slug(n)}/`).join(", ")}.`
      : "";
    return [
      `You are the "${stream.name}" workstream of a planned task.`,
      `Overall task: ${this.ctx.request}`,
      `What it is really asking: ${plan.summary}`,
      `\nYour steps:\n${mine.map((s) => `- ${s.id} ${s.title}: ${s.detail}`).join("\n")}`,
      others.length
        ? `\nOther agents handle (don't do their work):\n${others.map((w) => `- "${w.stream.name}": ${w.stream.stepIds.join(", ")}`).join("\n")}`
        : "",
      deps,
      coding
        ? "\nCommit your work on your branch with clear messages, and run the tests before you finish."
        : `\nWrite your results to outputs/ with clear file names${this.allocation?.synthesis ? "; a lead will combine everyone's outputs, so make yours self-explanatory" : ", including outputs/report.md"}.`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  private leadTask(): string {
    const coding = this.ctx.template === "coding";
    const steps = this.plan!.steps.filter((s) => this.allocation?.leadStepIds.includes(s.id));
    const branches = this.workers.flatMap((w) => (w.agentId ? [`agent-${w.agentId} ("${w.stream.name}")`] : []));
    return [
      `You are the lead of a planned task. Your workstreams have finished; combine their work into one result.`,
      `Overall task: ${this.ctx.request}`,
      `Plan summary: ${this.plan!.summary}`,
      steps.length ? `\nYour steps:\n${steps.map((s) => `- ${s.id} ${s.title}: ${s.detail}`).join("\n")}` : "",
      coding
        ? `\nMerge these branches into your branch: ${branches.join(", ")}. Resolve any conflicts, run the tests, fix what breaks, and commit.`
        : `\nEach workstream's outputs are in inputs/workers/<name>/; the original files are in inputs/. Write one combined deliverable to outputs/report.md (lead with the answer), with any charts or tables it needs.`,
      this.workers.some((w) => w.state === "error") ? "\nAt least one workstream ended with an error: check its outputs and fill the gap if you can." : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  private set(status: MissionStatus): void {
    this.status = status;
    if (/done|cancelled|failed/.test(status)) this.endedAt ??= Date.now();
    this.hooks.changed();
  }

  private fail(err: unknown): void {
    if (this.terminal) return;
    this.error = err instanceof Error ? err.message : String(err);
    this.set("failed");
    this.operation?.abort();
    this.stopActive("Task failed");
  }

  private get terminal(): boolean {
    return this.status === "done" || this.status === "cancelled" || this.status === "failed";
  }

  private newOperation(): AbortController {
    this.operation?.abort();
    return (this.operation = new AbortController());
  }

  private isCurrent(operation: AbortController): boolean {
    return this.operation === operation && !operation.signal.aborted && !this.terminal;
  }

  private stopActive(reason: string): void {
    for (const worker of this.workers) if (worker.agentId && worker.state === "running") this.hooks.stop?.(worker.agentId, reason);
    if (this.leadAgentId && this.leadState === "running") this.hooks.stop?.(this.leadAgentId, reason);
  }
}

// Until the short title arrives: the first sentence, cut at a word boundary.
export function fallbackTitle(text: string): string {
  const first = text.split(/(?<=[.!?])\s/)[0]!;
  if (first.length <= 70) return first;
  return first.slice(0, 70).replace(/\s+\S*$/, "") + "…";
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "work";
}
