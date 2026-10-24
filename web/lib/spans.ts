import type { AgentEvent, AgentStatus, Intent, RunStatus, SpanKind } from "../../server/types.ts";

// Each kind of event gets its own color, like spans in a trace waterfall.
export const EVENT_STYLE: Record<AgentEvent["kind"], { label: string; dot: string; bar: string }> = {
  text: { label: "think", dot: "bg-span-chat", bar: "bg-span-chat/80" },
  tool: { label: "tool", dot: "bg-span-tool", bar: "bg-span-tool/80" },
  steer: { label: "operator", dot: "bg-span-http", bar: "bg-span-http" },
  result: { label: "result", dot: "bg-span-workflow", bar: "bg-span-workflow/80" },
  error: { label: "error", dot: "bg-span-error", bar: "bg-span-error/80" },
};

export const STATUS_STYLE: Record<AgentStatus, { label: string; className: string; dot: string }> = {
  starting: { label: "starting", className: "text-muted-foreground border-border", dot: "bg-muted-foreground" },
  working: { label: "working", className: "text-span-retrieval border-span-retrieval/40 bg-span-retrieval/10", dot: "bg-span-retrieval animate-pulse" },
  idle: { label: "done", className: "text-span-tool border-span-tool/40 bg-span-tool/10", dot: "bg-span-tool" },
  paused: { label: "paused", className: "text-span-http border-span-http/40 bg-span-http/10", dot: "bg-span-http" },
  error: { label: "error", className: "text-span-error border-span-error/40 bg-span-error/10", dot: "bg-span-error" },
};

export const INTENT_STYLE: Record<Intent, { bar: string; text: string; dot: string }> = {
  assign: { bar: "bg-span-embed", text: "text-span-embed", dot: "bg-span-embed" },
  stop: { bar: "bg-span-error", text: "text-span-error", dot: "bg-span-error" },
  correct: { bar: "bg-span-workflow", text: "text-span-workflow", dot: "bg-span-workflow" },
  approve: { bar: "bg-span-tool", text: "text-span-tool", dot: "bg-span-tool" },
  rule: { bar: "bg-span-chat", text: "text-span-chat", dot: "bg-span-chat" },
  chatter: { bar: "bg-muted-foreground/50", text: "text-muted-foreground", dot: "bg-muted-foreground" },
};

export function targetLabel(target: string): string {
  if (target === "all") return "all agents";
  if (target === "none") return "nobody";
  if (target === "unclear") return "unclear";
  if (target === "new") return "new agent";
  return `agent ${target}`;
}

// Tool events arrive as "Bash · ls -la"; split them into name and detail.
export function splitTool(text: string): { name: string; detail: string } {
  const i = text.indexOf(" · ");
  return i < 0 ? { name: text, detail: "" } : { name: text.slice(0, i), detail: text.slice(i + 3) };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 2 : 1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

// Trace span colors. This order passed the palette validator (lightness,
// chroma, colorblind separation, contrast) on the light surface.
export const SPAN_KIND_STYLE: Record<SpanKind, { label: string; bar: string; dot: string }> = {
  invoke_agent: { label: "Agent", bar: "bg-span-agent", dot: "bg-span-agent" },
  chat: { label: "Model call", bar: "bg-span-chat", dot: "bg-span-chat" },
  execute_tool: { label: "Tool", bar: "bg-span-tool", dot: "bg-span-tool" },
  router: { label: "Router", bar: "bg-span-workflow", dot: "bg-span-workflow" },
  operator: { label: "Operator", bar: "bg-span-http", dot: "bg-span-http" },
};

export const RUN_STATUS_STYLE: Record<RunStatus, { label: string; className: string }> = {
  running: { label: "running", className: "text-span-retrieval border-span-retrieval/40 bg-span-retrieval/10" },
  success: { label: "success", className: "text-span-tool border-span-tool/40 bg-span-tool/10" },
  error: { label: "error", className: "text-span-error border-span-error/40 bg-span-error/10" },
  stopped: { label: "stopped", className: "text-span-http border-span-http/40 bg-span-http/10" },
  interrupted: { label: "interrupted", className: "text-muted-foreground border-border" },
};
