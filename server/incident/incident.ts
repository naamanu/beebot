import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { IncidentStatus, IncidentView, TimelineEntry } from "../types.ts";
import { Jamie, SAMPLE_PAST_INCIDENTS } from "./jamie.ts";
import { SERVICES, ShopfrontSim, type Metric, type Service } from "./sim.ts";

export const MCP_NAME = "shopfront";

// Tools that change production or speak to customers. The agent pauses on
// these until a human approves.
export const RISKY_TOOLS = new Set([`mcp__${MCP_NAME}__rollback_deploy`, `mcp__${MCP_NAME}__restart_service`, `mcp__${MCP_NAME}__post_status_update`]);

export const SAFE_TOOLS = [
  "list_services",
  "query_logs",
  "get_metrics",
  "list_deploys",
  "get_deploy",
  "search_past_incidents",
  "add_finding",
  "read_findings",
].map((t) => `mcp__${MCP_NAME}__${t}`);

export interface IncidentRole {
  name: string;
  task: string;
}

export const INCIDENT_ROLES: IncidentRole[] = [
  {
    name: "Logs",
    task: "Find the error signature in the logs and work out which service the failures originate from. Record what you find.",
  },
  {
    name: "Changes",
    task: "Correlate recent deploys and config changes with the start of impact. Identify the most likely culprit and say what a fix would be.",
  },
  {
    name: "Metrics",
    task: "Measure the blast radius: which services and user flows are affected, since when, and whether anything is saturated. Rule red herrings in or out.",
  },
  {
    name: "Comms",
    task: "Keep customers informed. Draft a short status update from the team's findings, post it, and post again when things change. Never speculate about causes in public.",
  },
];

export function incidentPrompt(role: string): string {
  return [
    `You are the ${role} investigator in a live production incident at Shopfront, an online store.`,
    "A human incident commander supervises you by voice; messages starting with [Operator] are from them.",
    `Use the ${MCP_NAME} tools to inspect production. You have no shell or file access, and none is needed.`,
    "Record each solid finding with add_finding (one sentence, with evidence) and read_findings to build on your teammates' work.",
    "Search past incidents early: history often repeats.",
    "Rollbacks, restarts and status-page posts need the commander's approval: call the tool and it will wait for them. Say in one sentence why before you call it.",
    "Be brief. Finish with a two-sentence summary of what you found.",
  ].join(" ");
}

export interface Finding {
  at: number;
  agentId: string;
  role: string;
  text: string;
}

export class Incident {
  readonly id = `inc-${Date.now().toString(36)}`;
  readonly sim: ShopfrontSim;
  status: IncidentStatus = "investigating";
  readonly declaredAt: number;
  timeline: TimelineEntry[] = [];
  findings: Finding[] = [];
  postmortem: string | null = null;
  jamieMeetingId: string | null = null;

  constructor(
    readonly title: string,
    readonly severity: "SEV1" | "SEV2",
    private jamie: Jamie,
    private onChange: () => void,
  ) {
    this.sim = new ShopfrontSim();
    this.declaredAt = this.sim.startedAt;
    this.log("declared", `Incident declared: ${title}`, "commander");
  }

  log(kind: TimelineEntry["kind"], text: string, by: string, at = Date.now()): void {
    this.timeline.push({ at, kind, text, by });
    this.onChange();
  }

  setStatus(status: IncidentStatus, by: string): void {
    if (this.status === status) return;
    this.status = status;
    this.log("status", `Status → ${status}`, by);
  }

  view(): IncidentView {
    const now = Date.now();
    return {
      id: this.id,
      title: this.title,
      severity: this.severity,
      status: this.status,
      declaredAt: this.declaredAt,
      impactAt: this.sim.impactAt,
      mitigatedAt: this.timeline.find((t) => t.kind === "status" && /mitigated|resolved/.test(t.text))?.at ?? null,
      errorRate: this.sim.series("checkout-api", "error_rate", 15, now).map((p) => ({ t: p.t, v: Math.round(p.v * 10) / 10 })),
      findings: this.findings,
      timeline: this.timeline,
      statusPosts: this.sim.statusPosts,
      hasPostmortem: !!this.postmortem,
      jamieMeetingId: this.jamieMeetingId,
    };
  }

  // Tools for one agent; add_finding needs to know who is speaking.
  mcpServer(agentId: string, role: string) {
    const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
    const service = z.enum(SERVICES);
    return createSdkMcpServer({
      name: MCP_NAME,
      version: "1.0.0",
      tools: [
        tool("list_services", "List Shopfront's production services.", {}, async () => text(SERVICES.join("\n"))),
        tool(
          "query_logs",
          "Read recent log lines from one service, newest last.",
          { service, since_minutes: z.number().min(1).max(240).default(15), contains: z.string().optional() },
          async ({ service, since_minutes, contains }) => {
            const lines = this.sim.logs(service as Service, since_minutes, contains);
            return text(lines.length ? lines.join("\n") : "(no matching log lines)");
          },
        ),
        tool(
          "get_metrics",
          "Get a metric for one service over a window. Metrics: error_rate (%), p95_latency_ms, rps, db_pool_in_use, cache_hit_ratio (%).",
          {
            service,
            metric: z.enum(["error_rate", "p95_latency_ms", "rps", "db_pool_in_use", "cache_hit_ratio"]),
            window_minutes: z.number().min(5).max(240).default(30),
          },
          async ({ service, metric, window_minutes }) => {
            const pts = this.sim.series(service as Service, metric as Metric, window_minutes);
            const step = Math.max(1, Math.floor(pts.length / 20));
            return text(
              pts
                .filter((_, i) => i % step === 0 || i === pts.length - 1)
                .map((p) => `${new Date(p.t).toISOString().slice(11, 19)}  ${p.v.toFixed(1)}`)
                .join("\n"),
            );
          },
        ),
        tool("list_deploys", "List recent deploys and config changes, newest first.", {}, async () =>
          text(
            [...this.sim.deploys]
              .sort((a, b) => b.at - a.at)
              .map((d) => `#${d.id}  ${new Date(d.at).toISOString().slice(11, 19)}  ${d.service.padEnd(13)} ${d.author.padEnd(14)} ${d.message}${d.rolledBackAt ? "  (rolled back)" : ""}`)
              .join("\n"),
          ),
        ),
        tool("get_deploy", "Show the diff of one deploy.", { deploy_id: z.string() }, async ({ deploy_id }) => {
          const d = this.sim.deploys.find((x) => x.id === deploy_id.replace("#", ""));
          return text(d ? `#${d.id} ${d.service} by ${d.author}: ${d.message}\n\n${d.diff}` : `No deploy #${deploy_id}`);
        }),
        tool(
          "search_past_incidents",
          "Search notes from past incident calls (recorded with Jamie) for similar problems.",
          { query: z.string() },
          async ({ query }) => {
            try {
              const hits = this.jamie.configured ? await this.jamie.search(query) : sampleSearch(query);
              if (!hits.length) return text("No past incidents matched.");
              return text(hits.slice(0, 5).map((h) => `${h.meetingDate} · ${h.meetingTitle ?? "Untitled"}\n${h.text}`).join("\n\n"));
            } catch (err) {
              return { ...text(`Search failed: ${(err as Error).message}`), isError: true };
            }
          },
        ),
        tool("add_finding", "Record a finding for the whole incident team (one sentence, with evidence).", { finding: z.string() }, async ({ finding }) => {
          this.findings.push({ at: Date.now(), agentId, role, text: finding });
          this.log("finding", finding, `${role} (agent ${agentId})`);
          return text("Recorded.");
        }),
        tool("read_findings", "Read everything the team has found so far.", {}, async () =>
          text(this.findings.length ? this.findings.map((f) => `[${f.role}] ${f.text}`).join("\n") : "No findings yet."),
        ),
        tool("rollback_deploy", "Roll back a deploy. Requires the incident commander's approval.", { deploy_id: z.string() }, async ({ deploy_id }) => {
          const result = this.sim.rollback(deploy_id.replace("#", ""));
          this.log("action", result, `${role} (agent ${agentId})`);
          return text(result);
        }),
        tool("restart_service", "Restart a service's pods. Requires approval.", { service }, async ({ service }) => {
          const result = this.sim.restart(service as Service);
          this.log("action", result, `${role} (agent ${agentId})`);
          return text(result);
        }),
        tool(
          "post_status_update",
          "Post a customer-facing update to the public status page. Requires approval.",
          { status: z.enum(["investigating", "identified", "monitoring", "resolved"]), message: z.string() },
          async ({ status, message }) => {
            const result = this.sim.postStatus(status, message);
            this.log("statuspage", `[${status}] ${message}`, `${role} (agent ${agentId})`);
            return text(result);
          },
        ),
      ],
    });
  }
}

function sampleSearch(query: string) {
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  return SAMPLE_PAST_INCIDENTS.filter((h) => words.some((w) => `${h.meetingTitle} ${h.text}`.toLowerCase().includes(w)));
}
