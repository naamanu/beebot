import { randomUUID } from "node:crypto";
import type { Allocation, MissionStatus, MissionView, Plan, Workstream } from "../types.ts";
import { allocate, planTask, type PlanContext } from "./planner.ts";

export interface SpawnRequest {
  role: string;
  title: string; // short, for the agent's card
  task: string;
  // General: copy these agents' outputs/ into inputs/<as>/. Coding: unused.
  inputsFrom: { agentId: string; as: string }[];
  // Coding: start the worktree from this agent's branch instead of main.
  baseAgentId: string | null;
}

export interface MissionHooks {
  spawn: (mission: Mission, req: SpawnRequest) => string; // returns the new agent id
  changed: () => void;
  speak: (text: string) => void;
}

type WorkerState = "waiting" | "running" | "done" | "error";

// One task, planned before it runs:
// planning → awaiting_approval → allocating → running → (synthesizing) → done
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

  constructor(
    private ctx: PlanContext,
    private hooks: MissionHooks,
  ) {}

  get template() {
    return this.ctx.template;
  }

  view(): MissionView {
    return {
      id: this.id,
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
      error: this.error,
    };
  }

  // --- phases ---

  async start(): Promise<void> {
    await this.makePlan();
  }

  async revise(note: string): Promise<void> {
    if (this.status !== "awaiting_approval") return;
    this.revisions.push(note);
    await this.makePlan();
  }

  async approve(): Promise<void> {
    if (this.status !== "awaiting_approval" || !this.plan) return;
    this.set("allocating");
    try {
      const { data, costUsd } = await allocate(this.ctx, this.plan);
      this.costUsd += costUsd;
      this.allocation = data;
      this.workers = data.workstreams.map((stream) => ({ stream, agentId: null, state: "waiting" as const }));
      const n = data.workstreams.length;
      this.hooks.speak(`Plan approved. Using ${n} agent${n === 1 ? "" : "s"}${data.synthesis ? " and a lead to combine their work" : ""}.`);
      this.set("running");
      this.startRunnable();
    } catch (err) {
      this.fail(err);
    }
  }

  cancel(): void {
    if (this.status === "done" || this.status === "cancelled") return;
    this.set("cancelled");
  }

  // Called when an agent of this mission reports a result.
  onAgentFinished(agentId: string, ok: boolean): void {
    if (this.status === "cancelled") return;
    if (agentId === this.leadAgentId) {
      this.leadState = ok ? "done" : "error";
      this.set(ok ? "done" : "failed");
      this.hooks.speak(ok ? "The lead has combined the results. Task done." : "The lead hit an error.");
      return;
    }
    const w = this.workers.find((x) => x.agentId === agentId);
    if (!w || w.state !== "running") return;
    w.state = ok ? "done" : "error";
    this.startRunnable();
  }

  // --- internals ---

  private async makePlan(): Promise<void> {
    this.set("planning");
    try {
      const { data, costUsd } = await planTask(this.ctx, this.revisions, this.plan);
      this.costUsd += costUsd;
      this.plan = data;
      this.set("awaiting_approval");
      this.hooks.speak(`Plan ready: ${data.steps.length} steps. Approve it, or tell me what to change.`);
    } catch (err) {
      this.fail(err);
    }
  }

  // Start every waiting workstream whose dependencies are finished; when all
  // are finished, hand over to the lead (or finish).
  private startRunnable(): void {
    const finished = (name: string) => this.workers.find((w) => w.stream.name === name)?.state.match(/done|error/);
    let ready = this.workers.filter((w) => w.state === "waiting" && w.stream.after.every(finished));
    const running = this.workers.some((w) => w.state === "running");
    // A dependency cycle would stall forever: break it by starting the first waiting one.
    if (!ready.length && !running) ready = this.workers.filter((w) => w.state === "waiting").slice(0, 1);
    for (const w of ready) {
      w.state = "running";
      w.agentId = this.hooks.spawn(this, {
        role: w.stream.name,
        title: this.plan!.steps.filter((s) => w.stream.stepIds.includes(s.id)).map((s) => `${s.id} ${s.title}`).join(" · "),
        task: this.workerTask(w.stream),
        inputsFrom: w.stream.after.flatMap((n) => {
          const dep = this.workers.find((x) => x.stream.name === n);
          return dep?.agentId ? [{ agentId: dep.agentId, as: `from-${slug(n)}` }] : [];
        }),
        baseAgentId: this.workers.find((x) => x.stream.name === w.stream.after[0])?.agentId ?? null,
      });
    }
    this.hooks.changed();
    if (this.workers.every((w) => w.state === "done" || w.state === "error")) this.finishWorkstreams();
  }

  private finishWorkstreams(): void {
    if (this.allocation?.synthesis && !this.leadAgentId) {
      this.set("synthesizing");
      this.leadState = "running";
      this.leadAgentId = this.hooks.spawn(this, {
        role: "Lead",
        title: `Combine ${this.workers.length} workstreams${this.allocation?.leadStepIds.length ? ` · ${this.allocation.leadStepIds.join(" ")}` : ""}`,
        task: this.leadTask(),
        inputsFrom: this.workers.flatMap((w) => (w.agentId ? [{ agentId: w.agentId, as: `workers/${slug(w.stream.name)}` }] : [])),
        baseAgentId: null,
      });
      this.hooks.changed();
    } else if (!this.leadAgentId) {
      const failed = this.workers.some((w) => w.state === "error");
      this.set(failed ? "failed" : "done");
      this.hooks.speak(failed ? "The task finished with errors." : "All workstreams are done.");
    }
  }

  private workerTask(stream: Workstream): string {
    const plan = this.plan!;
    const mine = plan.steps.filter((s) => stream.stepIds.includes(s.id));
    const others = this.workers.filter((w) => w.stream !== stream);
    const coding = this.ctx.template === "coding";
    const deps = stream.after.length
      ? coding
        ? `\nYour branch starts from the "${stream.after[0]}" workstream's branch, so its commits are already here.`
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
    this.hooks.changed();
  }

  private fail(err: unknown): void {
    this.error = err instanceof Error ? err.message : String(err);
    this.set("failed");
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "work";
}
