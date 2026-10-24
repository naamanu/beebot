import type { SDKAssistantMessage, SDKResultMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { estimateCost } from "./pricing.ts";
import type { Telemetry } from "./telemetry.ts";
import type { RouteVerdict } from "./types.ts";

const clip = (s: string, n = 4000) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more chars)` : s);

// Turns one agent's SDK message stream into runs and spans.
//
// A run opens when the agent is given work (a task, or an instruction while
// it is idle) and closes at the SDK's result message. Inside it:
//   chat          one per model response, timed from the previous activity
//   execute_tool  from the tool_use block to its tool_result
//   operator      an instruction from the human (instant)
//   router        the vote that produced that instruction
export class RunTracer {
  runId: string | null = null;
  private nextLabel: string | null = null;
  // An instruction given during a run often makes the SDK finish that turn and
  // start another. The next run is labelled with it and linked back.
  private followUp: { label: string; parentRunId: string } | null = null;
  private nextParent: string | null = null;
  private pendingRouter: RouteVerdict | null = null;
  private costAtStart = 0; // SDK cost is cumulative per session
  private estimatedCost = 0; // sum of chat estimates in the open run
  private lastActivity = Date.now();
  private stopping = false;
  private chats = new Map<string, { spanId: string; input: number; output: number; cacheRead: number; cacheWrite: number }>();
  private tools = new Map<string, string>(); // tool_use_id → span id

  constructor(
    private t: Telemetry,
    private agentId: string,
    private model: string,
    private workspace: string,
    private sessionId: () => string | null,
    restoredRunId: string | null,
    costSoFar: number,
  ) {
    this.runId = restoredRunId;
    this.costAtStart = costSoFar;
  }

  // Explicit new work: closes any open run (superseded) and opens a new one.
  begin(task: string): void {
    if (this.runId) this.close("stopped");
    this.nextParent = null;
    this.open(task);
  }

  // Work implied by an instruction: joins the open run, or labels the next.
  operator(text: string, attrs: Record<string, unknown> = {}): void {
    if (this.runId) {
      this.t.point(this.runId, "operator", text.split(":")[0]!, text, attrs);
      this.followUp = { label: text, parentRunId: this.runId };
    } else this.nextLabel ??= text;
  }

  router(v: RouteVerdict): void {
    if (!this.runId) {
      this.pendingRouter = v;
      return;
    }
    const end = Date.now();
    const id = this.t.startSpan(this.runId, "router", `${v.intent} → ${v.target}`, `“${v.utterance}”`, routerAttrs(v), end - v.ms);
    this.t.updateSpan(id, { endedAt: end });
  }

  markStopping(): void {
    this.stopping = true;
  }

  onSession(id: string): void {
    if (this.runId) this.t.setSession(this.runId, id);
  }

  onAssistant(msg: SDKAssistantMessage): void {
    const runId = this.ensureRun();
    const m = msg.message;
    const now = Date.now();
    const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    const toolNames = m.content.flatMap((b) => (b.type === "tool_use" ? [b.name] : []));

    let chat = this.chats.get(m.id);
    if (!chat) {
      const spanId = this.t.startSpan(runId, "chat", "chat", "", { model: m.model }, this.lastActivity);
      chat = { spanId, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      this.chats.set(m.id, chat);
    }

    // Streamed messages carry the request's input-side usage, but not final
    // output counts: those arrive on the result, which sets the run totals.
    const u = m.usage;
    const next = {
      input: u?.input_tokens ?? 0,
      output: 0,
      cacheRead: u?.cache_read_input_tokens ?? 0,
      cacheWrite: u?.cache_creation_input_tokens ?? 0,
    };
    const delta = {
      inputTokens: Math.max(0, next.input - chat.input),
      outputTokens: 0,
      cacheReadTokens: Math.max(0, next.cacheRead - chat.cacheRead),
      cacheWriteTokens: Math.max(0, next.cacheWrite - chat.cacheWrite),
    };
    this.t.addUsage(runId, delta);
    this.estimatedCost += estimateCost(m.model, delta);
    Object.assign(chat, next);

    const prev = this.prevAttrs.get(chat.spanId) ?? { text: "", tools: [] as string[] };
    const allText = [prev.text, text].filter(Boolean).join("\n");
    const allTools = [...prev.tools, ...toolNames];
    this.prevAttrs.set(chat.spanId, { text: allText, tools: allTools });
    this.t.updateSpan(chat.spanId, {
      endedAt: now,
      detail: allTools.length ? `→ ${allTools.join(", ")}` : allText.replace(/\s+/g, " ").slice(0, 120),
      attrs: {
        model: m.model,
        inputTokens: next.input,
        cacheReadTokens: next.cacheRead,
        cacheWriteTokens: next.cacheWrite,
        output: clip(allText),
        toolCalls: allTools,
      },
    });
    this.lastActivity = now;
  }
  private prevAttrs = new Map<string, { text: string; tools: string[] }>();

  onToolUse(id: string, name: string, description: string, input: unknown): void {
    const runId = this.ensureRun();
    const detail = description.includes(" · ") ? description.split(" · ").slice(1).join(" · ") : "";
    const short = name.startsWith("mcp__") ? name.split("__").pop()! : name;
    const spanId = this.t.startSpan(runId, "execute_tool", short, detail, { input: clip(JSON.stringify(input, null, 2)), tool: name });
    this.tools.set(id, spanId);
  }

  onUser(msg: SDKUserMessage): void {
    const content = msg.message.content;
    if (typeof content === "string") return;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const spanId = this.tools.get(block.tool_use_id);
      if (!spanId) continue;
      const output =
        typeof block.content === "string"
          ? block.content
          : (block.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
      this.t.updateSpan(spanId, { endedAt: Date.now(), status: block.is_error ? "error" : "ok", attrs: { output: clip(output) } });
      this.tools.delete(block.tool_use_id);
    }
    this.lastActivity = Date.now();
  }

  onResult(msg: SDKResultMessage): void {
    if (!this.runId) return;
    const status = msg.subtype === "success" ? "success" : this.stopping ? "stopped" : "error";
    // Per-turn usage from the SDK is exact; it replaces the running estimate.
    this.t.setUsage(this.runId, {
      inputTokens: msg.usage.input_tokens,
      outputTokens: msg.usage.output_tokens,
      cacheReadTokens: msg.usage.cache_read_input_tokens,
      cacheWriteTokens: msg.usage.cache_creation_input_tokens,
    });
    this.t.finishRun(this.runId, {
      status,
      costUsd: Math.max(0, msg.total_cost_usd - this.costAtStart),
      apiMs: msg.duration_api_ms,
      numTurns: msg.num_turns,
      result: msg.subtype === "success" ? clip(msg.result) : `Ended: ${msg.subtype}`,
    });
    this.costAtStart = msg.total_cost_usd;
    const followUp = this.followUp;
    this.reset();
    if (followUp) {
      this.nextLabel = followUp.label;
      this.nextParent = followUp.parentRunId;
    }
  }

  // The agent was closed (reset or shutdown) mid-run.
  abandon(status: "stopped" | "interrupted"): void {
    if (this.runId) this.close(status);
  }

  private open(task: string): string {
    this.runId = this.t.startRun({
      agentId: this.agentId,
      task,
      model: this.model,
      workspace: this.workspace,
      sessionId: this.sessionId(),
      parentRunId: this.nextParent,
    });
    this.t.startSpan(this.runId, "invoke_agent", `agent-${this.agentId}`, task, { model: this.model, workspace: this.workspace });
    this.lastActivity = Date.now();
    this.estimatedCost = 0;
    this.nextLabel = null;
    this.nextParent = null;
    if (this.pendingRouter) {
      this.router(this.pendingRouter);
      this.pendingRouter = null;
    }
    return this.runId;
  }

  private ensureRun(): string {
    return this.runId ?? this.open(this.nextLabel ?? "Continued work");
  }

  private close(status: "stopped" | "interrupted"): void {
    // No SDK result for a cut-off run, so its cost is the chat estimate.
    this.t.finishRun(this.runId!, { status, costUsd: this.estimatedCost });
    this.costAtStart += this.estimatedCost;
    this.reset();
  }

  private reset(): void {
    this.runId = null;
    this.followUp = null;
    this.stopping = false;
    this.chats.clear();
    this.tools.clear();
    this.prevAttrs.clear();
  }
}

function routerAttrs(v: RouteVerdict): Record<string, unknown> {
  return {
    utterance: v.utterance,
    target: v.target,
    intent: v.intent,
    instruction: v.instruction,
    confidence: v.confidence,
    votes: v.votes,
    action: v.action,
    inputTokens: v.usage.inputTokens,
    outputTokens: v.usage.outputTokens,
    costUsd: v.usage.costUsd,
  };
}
