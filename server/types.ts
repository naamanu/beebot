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
  role: string | null; // incident role, or a mission workstream name
  missionId: string | null;
  title: string | null; // short description for cards when the task is a long generated prompt
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
  postmortemState: "none" | "writing" | "ready" | "error"; // written automatically on resolve
  jamieMeetingId: string | null;
  declaredBy: string; // "watchtower" when it declared itself
  fixAppliedAt: number | null; // when the bad deploy was rolled back
}

export type Intent = "assign" | "stop" | "correct" | "approve" | "rule" | "incident" | "chatter";

export type IncidentAction = "declare" | "identified" | "mitigated" | "resolved" | "stand_down" | "none";

export interface RouteVerdict {
  utterance: string;
  target: string; // agent id, "new", "all", "none", or "unclear"
  intent: Intent;
  instruction: string;
  incidentAction: IncidentAction; // only meaningful when intent is "incident"
  confidence: number; // share of requested votes agreeing with the winner
  votes: { target: string; intent: Intent; count: number; incidentAction?: IncidentAction }[];
  action: "applied" | "clarify" | "ignored";
  ms: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
}

export interface Decision {
  verdict: RouteVerdict;
  question?: string;
}

export type MicStatus = "stopped" | "connecting" | "listening" | "error";

export type ServerMsg =
  | { type: "state"; watch: WatchView; proposals: Proposal[]; agents: AgentView[]; rules: string[]; decisions: Decision[]; incident: IncidentView | null; missions: MissionView[]; tasks: TaskView[] }
  | { type: "agent_event"; id: string; event: AgentEvent; status: AgentStatus; runId: string | null; costUsd: number }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "mic_state"; status: MicStatus; error?: string }
  | { type: "routing"; utterance: string }
  | { type: "verdict"; verdict: RouteVerdict }
  | { type: "speak"; text: string }
  | { type: "notice"; level: "info" | "error"; text: string }
  | { type: "telemetry" } // trace data changed: refetch
  | { type: "incident"; incident: IncidentView | null }
  | { type: "watch"; watch: WatchView };

export interface CommandContext {
  template: Template;
  attachments: string[];
  plan: boolean;
  taskId: string | null;
  uploading: boolean;
}

export type ClientMsg =
  | { type: "start"; tasks: string[] }
  | { type: "say"; text: string; template?: Template; attachments?: string[]; plan?: boolean; taskId?: string | null } // taskId: the task being viewed
  | { type: "plan_decision"; missionId: string; decision: "approve" | "revise" | "cancel"; note?: string }
  | { type: "complete_task"; taskId: string }
  | { type: "cancel_start"; id: string }
  | { type: "mic"; on: boolean }
  | { type: "command_context"; context: CommandContext }
  | { type: "reset" }
  | { type: "focus"; id: string | null }
  | { type: "select_task"; id: string | null } // so voice is scoped like typing
  | { type: "direct"; id: string; text: string }
  | { type: "control"; id: string; action: "stop" | "approve" }
  | { type: "approval"; id: string; decision: "approve" | "deny" }
  | { type: "declare_incident"; title: string }
  | { type: "incident_status"; status: IncidentStatus }
  | { type: "clear_rules" }
  | { type: "watch_toggle"; on: boolean }
  | { type: "simulate_outage" }
  | { type: "accept_proposal"; id: string }
  | { type: "dismiss_proposal"; id: string }
  | { type: "stand_down" };

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
  taskId: string | null;
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
  taskId?: string;
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

// --- Missions: plan first, approve, then decide how many agents ---

export type MissionStatus = "planning" | "awaiting_approval" | "allocating" | "running" | "synthesizing" | "ready" | "done" | "cancelled" | "failed";

export interface PlanStep {
  id: string; // "S1", "S2", …
  title: string;
  detail: string;
  dependsOn: string[];
}

export interface Plan {
  summary: string; // what the task is really asking, in one or two sentences
  steps: PlanStep[];
  risks: string[]; // ambiguities or things that could go wrong
}

export interface Workstream {
  name: string; // short, e.g. "Data prep"
  stepIds: string[];
  after: string[]; // names of workstreams whose outputs it needs first
  rationale: string;
}

export interface Allocation {
  reasoning: string; // why this many agents
  workstreams: Workstream[];
  synthesis: boolean; // a lead combines the workstreams at the end
  leadStepIds: string[]; // steps only the lead does (integration, final write-up)
}

export interface MissionView {
  id: string;
  title: string; // short, for lists
  quick: boolean; // started without a plan: one agent, right away
  followUp?: boolean; // started from a review call's action items
  request: string;
  template: "general" | "coding";
  files: string[];
  status: MissionStatus;
  plan: Plan | null;
  revisions: string[]; // notes the operator gave when revising the plan
  allocation: Allocation | null;
  workers: { name: string; agentId: string | null; state: "waiting" | "running" | "done" | "error" }[];
  leadAgentId: string | null;
  costUsd: number; // planning + allocation calls (agents report their own cost)
  createdAt: number;
  endedAt: number | null;
  error: string | null;
}

// --- Tasks: what the UI is organised around ---

export type TaskStatus = "planning" | "needs_you" | "working" | "ready" | "done" | "stopped" | "failed";

export interface TaskNeed {
  type: "plan" | "approval" | "completion";
  label: string;
  agentId?: string;
  approvalId?: string;
}

export interface TaskView {
  id: string; // the owning mission or incident id
  kind: "work" | "incident";
  title: string;
  request: string;
  template: Template;
  files: string[];
  status: TaskStatus;
  needs: TaskNeed[];
  createdAt: number;
  endedAt: number | null;
  missionId: string | null;
  agentIds: string[];
  resultAgentId: string | null; // whose result and outputs stand for the task
  result: string | null;
  branch: string | null; // coding: the branch with the finished work
  costUsd: number;
  followUp: boolean; // started from a review call's action items
}

// --- Proactive: the watchtower and what it proposes ---

export interface WatchView {
  enabled: boolean;
  errorRate: number; // checkout error rate now, %
  state: "healthy" | "anomaly";
  thresholdPct: number;
  lastCheckAt: number;
  series: { t: number; v: number }[]; // last 10 minutes
}

// Work the tower suggests on its own, e.g. action items from a review call.
export interface Proposal {
  id: string;
  source: "jamie" | "tower";
  // tower: a fix it proposes itself when the investigators stopped short.
  action?: { type: "rollback"; deployId: string };
  title: string;
  items: string[];
  createdAt: number;
  status: "open" | "accepted" | "dismissed";
}
