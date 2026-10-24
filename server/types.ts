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
}

export interface Decision {
  verdict: RouteVerdict;
  question?: string;
}

export type ServerMsg =
  | { type: "state"; agents: AgentView[]; rules: string[]; decisions: Decision[] }
  | { type: "agent_event"; id: string; event: AgentEvent; status: AgentStatus }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "routing"; utterance: string }
  | { type: "verdict"; verdict: RouteVerdict }
  | { type: "speak"; text: string }
  | { type: "notice"; level: "info" | "error"; text: string };

export type ClientMsg =
  | { type: "start"; tasks: string[] }
  | { type: "say"; text: string }
  | { type: "mic"; on: boolean }
  | { type: "reset" }
  | { type: "focus"; id: string | null }
  | { type: "direct"; id: string; text: string }
  | { type: "control"; id: string; action: "stop" | "approve" }
  | { type: "clear_rules" };
