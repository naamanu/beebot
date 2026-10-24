import { relative } from "node:path";
import { query, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { MCP_NAME, RISKY_TOOLS, SAFE_TOOLS, incidentPrompt, type Incident } from "./incident/incident.ts";
import type { Telemetry } from "./telemetry.ts";
import { RunTracer } from "./tracer.ts";
import type { AgentEvent, AgentStatus, AgentView, Approval, RouteVerdict, Template } from "./types.ts";

// An async iterable we can keep pushing user messages into. The Agent SDK's
// streaming input mode reads from it for the whole session, which is what lets
// us steer an agent while it works.
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiting: ((r: IteratorResult<SDKUserMessage>) => void) | null = null;
  private closed = false;

  push(text: string, priority: "now" | "next" | "later" = "next"): void {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      priority,
    };
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: msg, done: false });
    } else {
      this.items.push(msg);
    }
  }

  close(): void {
    this.closed = true;
    this.waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}

export interface AgentOptions {
  id: string;
  task: string;
  cwd: string;
  model: string;
  rules: () => string;
  onEvent: (id: string, event: AgentEvent, status: AgentStatus) => void;
  telemetry: Telemetry;
  workspace: string;
  restore?: AgentSnapshot;
  template?: Exclude<Template, "incident">; // default "coding"
  // Incident agents use the shopfront tools instead of a code checkout.
  incident?: { incident: Incident; role: string };
  onApproval?: (agent: Agent, approval: Approval | null) => void;
}

// Everything needed to bring an agent back after a server restart.
export interface AgentSnapshot {
  id: string;
  task: string;
  cwd: string;
  status: AgentStatus;
  events: AgentEvent[];
  costUsd: number;
  sessionId: string | null;
  runId?: string | null;
  template?: Template;
}

export class Agent {
  status: AgentStatus = "starting";
  events: AgentEvent[] = [];
  costUsd = 0;
  private task_: string;
  private sessionId: string | null = null;
  private inbox = new Inbox();
  private q: Query | null = null;
  private tracer: RunTracer;
  private pending: { approval: Approval; resolve: (r: PermissionResult) => void } | null = null;

  constructor(private opts: AgentOptions) {
    this.task_ = opts.task;
    if (opts.restore) {
      this.status = opts.restore.status;
      this.events = opts.restore.events;
      this.costUsd = opts.restore.costUsd;
      this.sessionId = opts.restore.sessionId;
    }
    const live = opts.restore && (opts.restore.status === "working" || opts.restore.status === "starting");
    this.tracer = new RunTracer(
      opts.telemetry,
      opts.id,
      opts.model,
      opts.workspace,
      () => this.sessionId,
      live ? (opts.restore?.runId ?? null) : null,
      this.costUsd,
    );
  }

  get id(): string {
    return this.opts.id;
  }

  get task(): string {
    return this.task_;
  }

  get template(): Template {
    return this.opts.incident ? "incident" : (this.opts.template ?? "coding");
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  // A new agent waits out a short undo window before it starts spending.
  startsAt: number | null = null;
  private startTimer: ReturnType<typeof setTimeout> | undefined;

  beginAfter(ms: number, onStart: () => void): void {
    this.startsAt = Date.now() + ms;
    this.startTimer = setTimeout(() => {
      this.startsAt = null;
      this.begin();
      onStart();
    }, ms);
  }

  // Undo before it started: nothing ran, nothing was spent.
  cancelStart(): boolean {
    if (this.startsAt === null) return false;
    clearTimeout(this.startTimer);
    this.startsAt = null;
    return true;
  }

  get runId(): string | null {
    return this.tracer.runId;
  }

  view(): AgentView {
    return {
      id: this.id,
      task: this.task,
      status: this.status,
      events: this.events.slice(-200),
      costUsd: this.costUsd,
      runId: this.tracer.runId,
      template: this.template,
      role: this.opts.incident?.role ?? null,
      approval: this.pending?.approval ?? null,
      startsAt: this.startsAt,
    };
  }

  snapshot(): AgentSnapshot {
    return {
      id: this.id,
      task: this.task,
      cwd: this.opts.cwd,
      status: this.status,
      events: this.events.slice(-200),
      costUsd: this.costUsd,
      sessionId: this.sessionId,
      runId: this.tracer.runId,
      template: this.template,
    };
  }

  // Kick off the agent on its task.
  begin(): void {
    this.tracer.begin(this.task);
    this.inbox.push(this.task);
    this.ensureStarted();
  }

  // After a server restart: pick the session back up where it stopped.
  resumeAfterRestart(): void {
    this.log("steer", "↻ Server restarted, resuming", "working");
    this.tracer.operator("Server restarted: resuming");
    this.inbox.push("[Operator] The control server restarted while you were working. Continue where you left off.");
    this.ensureStarted();
  }

  // Starts the Agent SDK session on first use. A restored agent resumes its
  // previous Claude session, so it keeps the whole conversation.
  private ensureStarted(): void {
    if (this.q) return;
    this.q = query({ prompt: this.inbox, options: this.options() });
    void this.pump(this.q);
  }

  private options(): Options {
    const common = { cwd: this.opts.cwd, model: this.opts.model, resume: this.sessionId ?? undefined };
    const inc = this.opts.incident;
    if (inc) {
      return {
        ...common,
        tools: [], // no shell or files: production is reached through the shopfront tools
        mcpServers: { [MCP_NAME]: inc.incident.mcpServer(this.id, inc.role) },
        allowedTools: SAFE_TOOLS,
        canUseTool: (toolName, input, { signal }) => this.checkTool(toolName, input, signal),
        systemPrompt: incidentPrompt(inc.role) + this.opts.rules(),
      };
    }
    if (this.template === "general") {
      return {
        ...common,
        permissionMode: "acceptEdits",
        allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            `You are agent ${this.id}, a general-purpose agent supervised live by a human operator who speaks instructions; ` +
            `messages starting with [Operator] are from them and take priority. Work only inside your current directory. ` +
            `Files the operator attached are in ./inputs. Put every deliverable in ./outputs: a report as outputs/report.md ` +
            `(lead with the answer), charts as PNG or SVG, tables as CSV. The operator sees ./outputs, not your scratch files. ` +
            `For data work, Python packages are not installed system-wide: run scripts with ` +
            `\`uv run --with pandas --with matplotlib script.py\` (add other packages the same way). ` +
            `Keep progress notes to one short sentence, and finish with a two-sentence summary of what you found.` +
            this.opts.rules(),
        },
      };
    }
    return {
      ...common,
      permissionMode: "acceptEdits",
      allowedTools: ["Read", "Edit", "Write", "Glob", "Grep", "Bash"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          `You are agent ${this.id}, one of several coding agents supervised live by a human operator who speaks instructions. ` +
          `Work only inside your current directory. Messages starting with [Operator] come from that human: follow them immediately, ` +
          `even if it means abandoning your current approach. Keep progress notes to one short sentence.` +
          this.opts.rules(),
      },
    };
  }

  // Risky tools wait here for a human decision; anything else unexpected is refused.
  private checkTool(toolName: string, input: Record<string, unknown>, signal: AbortSignal): Promise<PermissionResult> {
    if (!RISKY_TOOLS.has(toolName)) return Promise.resolve({ behavior: "deny", message: `${toolName} is not available in this incident.` });
    const approval: Approval = {
      id: randomUUID(),
      agentId: this.id,
      tool: toolName.replace(`mcp__${MCP_NAME}__`, ""),
      summary: describeAction(toolName, input),
      input,
      at: Date.now(),
    };
    this.log("approval", `⏸ Needs approval: ${approval.summary}`, "blocked");
    return new Promise((resolve) => {
      this.pending = { approval, resolve };
      this.opts.onApproval?.(this, approval);
      signal.addEventListener("abort", () => this.decide("deny", "cancelled"), { once: true });
    });
  }

  get approval(): Approval | null {
    return this.pending?.approval ?? null;
  }

  decide(decision: "approve" | "deny", by: string, note?: string): Approval | null {
    const p = this.pending;
    if (!p) return null;
    this.pending = null;
    if (decision === "approve") {
      this.log("approval", `✓ Approved by ${by}: ${p.approval.summary}`, "working");
      this.tracer.operator(`Approved: ${p.approval.summary}`, { by });
      p.resolve({ behavior: "allow", updatedInput: p.approval.input });
    } else {
      this.log("approval", `✕ Denied by ${by}: ${p.approval.summary}${note ? ` (${note})` : ""}`, "working");
      this.tracer.operator(`Denied: ${p.approval.summary}`, { by });
      p.resolve({ behavior: "deny", message: `The incident commander denied this${note ? `: ${note}` : "."} Do not retry it unless asked.` });
    }
    this.opts.onApproval?.(this, null);
    return p.approval;
  }

  // Stop: interrupt the running turn. The session stays alive so a later
  // correction resumes it.
  async stop(reason: string): Promise<void> {
    this.log("steer", `⏹ ${reason}`, "paused");
    this.tracer.operator(`Stop: ${reason}`);
    this.tracer.markStopping();
    await this.q?.interrupt().catch(() => undefined);
  }

  // Correction: delivered with priority "now" so it is folded into the
  // running turn instead of waiting for the agent to finish.
  correct(instruction: string): void {
    this.log("steer", `↪ ${instruction}`, "working");
    this.tracer.operator(`Correct: ${instruction}`);
    this.inbox.push(`[Operator] ${instruction}`, "now");
    this.ensureStarted();
  }

  approve(instruction: string): void {
    this.log("steer", `✓ ${instruction}`, "working");
    this.tracer.operator(`Approve: ${instruction}`);
    this.inbox.push(
      `[Operator] Approved: ${instruction}. Wrap up now: make sure tests pass, then commit your work with a clear message.`,
      "next",
    );
    this.ensureStarted();
  }

  // A new task replaces whatever the agent was doing.
  assign(task: string): void {
    const busy = this.status === "working";
    this.task_ = task;
    this.log("steer", `＋ New task: ${task}`, "working");
    this.tracer.begin(task);
    this.inbox.push(
      `[Operator] New task${busy ? " (drop what you were doing)" : ""}: ${task}`,
      busy ? "now" : "next",
    );
    this.ensureStarted();
  }

  addRule(rule: string): void {
    this.log("steer", `§ New rule: ${rule}`, this.status);
    if (this.tracer.runId) this.tracer.operator(`Rule: ${rule}`);
    // A session that hasn't started picks the rule up from its system prompt.
    if (this.q) this.inbox.push(`[Operator] New standing rule for all agents: ${rule}. Check your current work against it.`, "next");
  }

  // The router vote behind an instruction, shown in the run's trace.
  traceRouter(v: RouteVerdict): void {
    this.tracer.router(v);
  }

  // reset: the user stopped everything. shutdown: the server is restarting
  // and the run will be resumed, so leave it open.
  close(reason: "reset" | "shutdown" = "shutdown"): void {
    clearTimeout(this.startTimer);
    if (this.pending) this.decide("deny", "system", "agent closed");
    if (reason === "reset") this.tracer.abandon("stopped");
    this.inbox.close();
    this.q?.close();
  }

  private async pump(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.handle(msg);
    } catch (err) {
      this.log("error", err instanceof Error ? err.message : String(err), "error");
    }
  }

  private handle(msg: SDKMessage): void {
    switch (msg.type) {
      case "assistant":
        if (msg.parent_tool_use_id) return; // skip subagent chatter
        this.tracer.onAssistant(msg);
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            this.flushText();
            this.pendingText = block.text.trim();
          }
          if (block.type === "tool_use") {
            this.flushText();
            const description = describeTool(block.name, block.input, this.opts.cwd);
            this.tracer.onToolUse(block.id, block.name, description, block.input);
            this.log("tool", description, "working");
          }
        }
        break;
      case "user":
        if (!msg.parent_tool_use_id) this.tracer.onUser(msg);
        break;
      case "result":
        this.tracer.onResult(msg);
        this.costUsd = msg.total_cost_usd;
        // The turn's last message is usually the result itself: show it once, as the result.
        if (msg.subtype === "success" && this.pendingText?.trim() === (msg.result ?? "").trim()) this.pendingText = null;
        this.flushText();
        if (msg.subtype === "success") this.log("result", msg.result || "Done.", "idle");
        else if (this.status !== "paused") this.log("error", `Stopped: ${msg.subtype}`, "idle");
        break;
      case "system":
        if (msg.subtype === "init") {
          this.sessionId = msg.session_id;
          this.tracer.onSession(msg.session_id);
        }
        if (msg.subtype === "session_state_changed" && msg.state === "running" && this.status !== "paused") {
          this.setStatus("working");
        }
        break;
    }
  }

  // Text is held until the next event, so a final message that repeats the
  // result isn't shown twice.
  private pendingText: string | null = null;

  private flushText(): void {
    if (this.pendingText) this.log("text", this.pendingText, "working");
    this.pendingText = null;
  }

  private log(kind: AgentEvent["kind"], text: string, status: AgentStatus): void {
    const event = { at: Date.now(), kind, text };
    this.events.push(event);
    this.status = status;
    this.opts.onEvent(this.id, event, status);
  }

  private setStatus(status: AgentStatus): void {
    this.status = status;
  }
}

function describeAction(toolName: string, input: Record<string, unknown>): string {
  const tool = toolName.replace(`mcp__${MCP_NAME}__`, "");
  if (tool === "rollback_deploy") return `Roll back deploy #${String(input.deploy_id).replace("#", "")}`;
  if (tool === "restart_service") return `Restart ${String(input.service)}`;
  if (tool === "post_status_update") return `Post to status page [${String(input.status)}]: “${String(input.message)}”`;
  return tool;
}

function describeTool(name: string, input: unknown, cwd: string): string {
  // MCP tools arrive as mcp__shopfront__query_logs: show the short name.
  if (name.startsWith("mcp__")) {
    const short = name.split("__").pop()!;
    const i = (input ?? {}) as Record<string, unknown>;
    const args = Object.values(i).map((v) => String(v)).join(" ");
    return `${short}${args ? ` · ${args.length > 90 ? args.slice(0, 90) + "…" : args}` : ""}`;
  }
  const i = (input ?? {}) as Record<string, unknown>;
  // Show paths relative to the agent's worktree: "src/store.js", not the full path.
  const path = i.file_path ?? i.path;
  const arg = typeof path === "string" ? relative(cwd, path) || "." : (i.command ?? i.pattern ?? "");
  const s = String(arg).replaceAll(cwd + "/", "").replace(/\s+/g, " ");
  return `${name}${s ? ` · ${s.length > 90 ? s.slice(0, 90) + "…" : s}` : ""}`;
}
