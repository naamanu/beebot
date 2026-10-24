// Shared message shapes between server and browser.

export type AgentStatus = "starting" | "working" | "idle" | "paused" | "error" | "blocked"; // blocked: waiting for approval

export type AgentEventKind = "text" | "tool" | "steer" | "result" | "error" | "approval";

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
  template: Template;
  role: string | null; // incident role, e.g. "Logs"
  startsAt: number | null; // set while a new agent waits out its undo window
  approval: Approval | null; // a risky action waiting for a human
}

// What kind of work an agent does. "general" works on attached files and
// writes deliverables to outputs/; "coding" works in a git worktree.
export type Template = "general" | "coding" | "incident";

export interface Upload {
  id: string;
  name: string;
  size: number;
}

export interface OutputFile {
  name: string;
  size: number;
  modifiedAt: number;
}

export interface RoutePreview {
  target: string;
  intent: Intent;
  incidentAction: IncidentAction;
  instruction: string;
}

export interface Approval {
  id: string;
  agentId: string;
  tool: string; // short name, e.g. "rollback_deploy"
  summary: string; // human-readable, e.g. "Roll back deploy #482"
  input: Record<string, unknown>;
  at: number;
}

export type IncidentStatus = "investigating" | "identified" | "mitigated" | "resolved";

export interface TimelineEntry {
  at: number;
  kind: "declared" | "status" | "finding" | "action" | "approval" | "statuspage" | "instruction";
  text: string;
  by: string;
}

export interface IncidentView {
  id: string;
  title: string;
  severity: "SEV1" | "SEV2";
  status: IncidentStatus;
  declaredAt: number;
  impactAt: number;
  mitigatedAt: number | null;
  errorRate: { t: number; v: number }[]; // checkout error rate, %, last 15 min
  findings: { at: number; agentId: string; role: string; text: string }[];
  timeline: TimelineEntry[];
  statusPosts: { at: number; status: string; message: string }[];
  hasPostmortem: boolean;
  jamieMeetingId: string | null;
}

export type Intent = "assign" | "stop" | "correct" | "approve" | "rule" | "incident" | "chatter";

export type IncidentAction = "declare" | "identified" | "mitigated" | "resolved" | "none";

export interface RouteVerdict {
  utterance: string;
  target: string; // agent id, "new", "all", "none", or "unclear"
  intent: Intent;
  instruction: string;
  incidentAction: IncidentAction; // only meaningful when intent is "incident"
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
  | { type: "state"; agents: AgentView[]; rules: string[]; decisions: Decision[]; incident: IncidentView | null }
  | { type: "agent_event"; id: string; event: AgentEvent; status: AgentStatus; runId: string | null; costUsd: number }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "routing"; utterance: string }
  | { type: "verdict"; verdict: RouteVerdict }
  | { type: "speak"; text: string }
  | { type: "notice"; level: "info" | "error"; text: string }
  | { type: "telemetry" } // trace data changed: refetch
  | { type: "incident"; incident: IncidentView | null };

export type ClientMsg =
  | { type: "start"; tasks: string[] }
  | { type: "say"; text: string; template?: Template; attachments?: string[] } // attachments: upload ids
  | { type: "cancel_start"; id: string }
  | { type: "mic"; on: boolean }
  | { type: "reset" }
  | { type: "focus"; id: string | null }
  | { type: "direct"; id: string; text: string }
  | { type: "control"; id: string; action: "stop" | "approve" }
  | { type: "approval"; id: string; decision: "approve" | "deny" }
  | { type: "declare_incident"; title: string }
  | { type: "incident_status"; status: IncidentStatus }
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
