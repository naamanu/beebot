// Shared message shapes between server and browser.

export type AgentStatus = "starting" | "working" | "idle" | "paused" | "error";

export type AgentEventKind = "text" | "tool" | "steer" | "result" | "error";

export interface AgentEvent {
  at: number;
  kind: AgentEventKind;
  text: string;
}

export interface AgentView {
  id: string;
  task: string;
  status: AgentStatus;
  events: AgentEvent[];
  costUsd: number;
  runId: string | null; // the run in progress, for linking to its trace
}

export type Intent = "assign" | "stop" | "correct" | "approve" | "rule" | "chatter";

export interface RouteVerdict {
  utterance: string;
  target: string; // agent id, "new", "all", "none", or "unclear"
  intent: Intent;
  instruction: string;
  confidence: number; // share of votes agreeing with the winner
  votes: { target: string; intent: Intent; count: number }[];
  action: "applied" | "clarify" | "ignored";
  ms: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

export interface Decision {
  verdict: RouteVerdict;
  question?: string;
}

export type ServerMsg =
  | { type: "state"; agents: AgentView[]; rules: string[]; decisions: Decision[] }
  | { type: "agent_event"; id: string; event: AgentEvent; status: AgentStatus; runId: string | null }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "routing"; utterance: string }
  | { type: "verdict"; verdict: RouteVerdict }
  | { type: "speak"; text: string }
  | { type: "notice"; level: "info" | "error"; text: string }
  | { type: "telemetry" }; // trace data changed: refetch

export type ClientMsg =
  | { type: "start"; tasks: string[] }
  | { type: "say"; text: string }
  | { type: "mic"; on: boolean }
  | { type: "reset" }
  | { type: "focus"; id: string | null }
  | { type: "direct"; id: string; text: string }
  | { type: "control"; id: string; action: "stop" | "approve" }
  | { type: "clear_rules" };

// --- Telemetry ---

export type RunStatus = "running" | "success" | "error" | "stopped" | "interrupted";

// OpenTelemetry GenAI span names, plus the two things only Control Tower has.
export type SpanKind = "invoke_agent" | "chat" | "execute_tool" | "router" | "operator";

export interface RunRow {
  id: string;
  agentId: string;
  task: string;
  model: string;
  status: RunStatus;
  startedAt: number;
  endedAt: number | null;
  apiMs: number | null;
  numTurns: number | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolCalls: number;
  toolErrors: number;
  steers: number;
  result: string | null;
  workspace: string | null;
  sessionId: string | null;
  parentRunId: string | null; // the run this one continues (e.g. after a mid-run correction)
}

export interface SpanRow {
  id: string;
  runId: string;
  kind: SpanKind;
  name: string;
  detail: string;
  startedAt: number;
  endedAt: number | null;
  status: "ok" | "error";
  attrs: Record<string, unknown>;
}

export interface RunDetail {
  run: RunRow;
  spans: SpanRow[];
}

export interface RunsQuery {
  status?: RunStatus;
  agent?: string;
  q?: string;
  limit?: number;
}

export interface TelemetrySummary {
  runs: number;
  running: number;
  success: number;
  failed: number;
  costUsd: number;
  routerCostUsd: number;
  routerDecisions: number;
  routerAvgConfidence: number;
  routerClarifications: number;
  routerAvgMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  toolCalls: number;
  toolErrors: number;
  steers: number;
  p50Ms: number;
  p95Ms: number;
}
