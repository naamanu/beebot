import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { IncidentStatus, IncidentView, SkippedInvestigation, TimelineEntry } from "../types.ts";
import { isRecovered } from "../tasks.ts";
import { Jamie, SAMPLE_PAST_INCIDENTS } from "./jamie.ts";
import { assertMetric, assertService, type ActionResult, type Deploy, type Point, type ProductionSource, type StatusPost } from "../production/source.ts";
import { FindingsReview } from "./recommendation.ts";

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
    "Timing alone does not prove a deploy caused the outage. Check the failure mechanism and consider external provider failures. Only propose a rollback when recorded evidence links the change to the failure; otherwise record what is missing and suggest the next checks.",
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

// Everything needed to show, resume or write up an incident after a restart.
export interface IncidentRecord {
  id: string;
  title: string;
  severity: "SEV1" | "SEV2";
  status: IncidentStatus;
  declaredAt: number;
  declaredBy: string;
  detectedAt: number | null;
  impactAt: number;
  fixAppliedAt: number | null;
  timeline: TimelineEntry[];
  findings: Finding[];
  statusPosts: StatusPost[];
  postmortem: string | null;
  jamieMeetingId: string | null;
  skippedInvestigation?: SkippedInvestigation;
  series: Point[];
  deploys: Deploy[];
  source: { id: string; label: string; simulated: boolean };
}

export interface IncidentOptions {
  declaredBy?: string;
  detectedAt?: number | null; // first breaching sample, when the watchtower declared it
  restore?: IncidentRecord;
}

export class Incident {
  readonly id: string;
  status: IncidentStatus = "investigating";
  readonly declaredAt: number;
  readonly declaredBy: string;
  readonly detectedAt: number | null;
  timeline: TimelineEntry[] = [];
  findings: Finding[] = [];
  statusPosts: StatusPost[] = [];
  postmortem: string | null = null;
  postmortemState: "none" | "writing" | "ready" | "error" = "none";
  jamieMeetingId: string | null = null;
  readonly review: FindingsReview;
  skippedInvestigation?: SkippedInvestigation;
  readonly interrupted: boolean;
  // Polled from the source so views render without waiting on a backend.
  series: Point[] = [];
  deploys: Deploy[] = [];
  private services: string[] = [];
  private rolledBackAt: number | null = null; // a rollback this incident applied
  private saved: Pick<IncidentRecord, "impactAt" | "fixAppliedAt"> | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    readonly title: string,
    readonly severity: "SEV1" | "SEV2",
    private jamie: Jamie,
    private onChange: () => void,
    readonly source: ProductionSource,
    { declaredBy = "commander", detectedAt = null, restore }: IncidentOptions = {},
  ) {
    this.review = new FindingsReview(onChange);
    this.declaredBy = restore?.declaredBy ?? declaredBy;
    this.detectedAt = restore?.detectedAt ?? detectedAt;
    this.interrupted = !!restore;
    if (restore) {
      this.id = restore.id;
      this.declaredAt = restore.declaredAt;
      this.status = restore.status;
      this.timeline = restore.timeline;
      this.findings = restore.findings;
      this.statusPosts = restore.statusPosts;
      this.postmortem = restore.postmortem;
      this.postmortemState = restore.postmortem ? "ready" : "none";
      this.jamieMeetingId = restore.jamieMeetingId;
      this.skippedInvestigation = restore.skippedInvestigation;
      this.series = restore.series;
      this.deploys = restore.deploys;
      this.saved = { impactAt: restore.impactAt, fixAppliedAt: restore.fixAppliedAt };
      return;
    }
    this.id = `inc-${Date.now().toString(36)}`;
    this.declaredAt = Date.now();
    this.log("declared", this.declaredBy === "watchtower" ? `Detected and declared by the watchtower: ${title}` : `Incident declared: ${title}`, this.declaredBy);
  }

  log(kind: TimelineEntry["kind"], text: string, by: string, at = Date.now()): void {
    this.timeline.push({ at, kind, text, by });
    this.onChange();
  }

  // Pull the latest health series and deploys. Concurrent calls share one fetch;
  // a failing backend keeps the last good snapshot.
  refresh(now = Date.now()): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const { service, metric } = this.source.health;
        const [series, deploys, services] = await Promise.all([
          this.source.series(service, metric, 15, now),
          this.source.deploys(now),
          this.source.services(),
        ]);
        this.series = series.map((p) => ({ t: p.t, v: Math.round(p.v * 10) / 10 }));
        // Merge rather than replace: a deploy seen during the incident stays in
        // its evidence even if the source stops listing it (history window,
        // or a simulator that restarted). Live data wins for known IDs.
        const live = new Map(deploys.map((d) => [d.id, d]));
        this.deploys = [...this.deploys.filter((d) => !live.has(d.id)), ...deploys];
        this.services = services;
        this.onChange();
      } catch (err) {
        console.warn(`Could not refresh production data from ${this.source.label}: ${(err as Error).message}`);
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  get impactAt(): number {
    return this.source.impactStartedAt?.() ?? this.saved?.impactAt ?? this.detectedAt ?? this.declaredAt;
  }

  // When a fix took effect. A source that models remediation (the simulator)
  // is authoritative; otherwise the rollback this incident applied counts.
  get fixAppliedAt(): number | null {
    if (this.source.remediatedAt) return this.source.remediatedAt() ?? this.saved?.fixAppliedAt ?? null;
    return this.rolledBackAt ?? this.saved?.fixAppliedAt ?? null;
  }

  setStatus(status: IncidentStatus, by: string): void {
    if (this.status === status) return;
    this.status = status;
    this.log("status", `Status → ${status}`, by);
  }

  async rollback(deployId: string, by: string): Promise<ActionResult> {
    const result = await this.source.rollback(deployId.replace("#", ""));
    if (result.ok) this.rolledBackAt ??= Date.now();
    this.log("action", result.message, by);
    void this.refresh();
    return result;
  }

  skipInvestigation(by: string): void {
    if (this.status === "resolved") throw new Error("This investigation is already closed.");
    const { state, decision } = this.review.view;
    if (state !== "ready" || decision?.action !== "investigate") throw new Error("There are no pending investigation checks to skip.");
    const at = Date.now();
    const recoveryConfirmed = isRecovered(this.view());
    const demo = this.source.demo;
    demo?.restore(at);
    this.skippedInvestigation = {
      at, by, reason: decision.reason,
      openQuestions: [...decision.missingEvidence],
      recoveryConfirmed,
      ...(demo ? { demoRecoveryAt: at } : {}),
    };
    if (demo) this.log("action", "Demo reset: simulated services restored to healthy immediately. This was a simulator control, not an agent fix or rollback; the diagnosis and open questions remain unchanged.", "simulator", at);
    this.log("instruction", `Commander skipped further investigation and closed the investigation with open questions.${demo ? " Simulated customer impact ended with the explicit demo reset." : ""}\nAssessment: ${decision.reason}\nDeferred checks:\n${decision.missingEvidence.map((q) => `- ${q}`).join("\n")}`, by, at);
    if (demo) void this.refresh();
  }

  view(): IncidentView {
    return {
      id: this.id,
      title: this.title,
      severity: this.severity,
      status: this.status,
      declaredAt: this.declaredAt,
      impactAt: this.impactAt,
      mitigatedAt: this.skippedInvestigation?.demoRecoveryAt ?? (this.skippedInvestigation && !this.skippedInvestigation.recoveryConfirmed ? null : this.timeline.find((t) => t.kind === "status" && /mitigated|resolved/.test(t.text))?.at ?? null),
      errorRate: this.series,
      findings: this.findings,
      timeline: this.timeline,
      statusPosts: this.statusPosts,
      hasPostmortem: !!this.postmortem,
      postmortemState: this.postmortemState,
      jamieMeetingId: this.jamieMeetingId,
      declaredBy: this.declaredBy,
      fixAppliedAt: this.fixAppliedAt,
      recommendation: this.review.view,
      skippedInvestigation: this.skippedInvestigation,
      canSkipInvestigation: this.status !== "resolved" && this.review.view.state === "ready" && this.review.view.decision?.action === "investigate",
      source: { id: this.source.id, label: this.source.label, simulated: this.source.simulated },
      healthLabel: this.source.health.label,
      interrupted: this.interrupted || undefined,
    };
  }

  record(): IncidentRecord {
    return {
      id: this.id, title: this.title, severity: this.severity, status: this.status,
      declaredAt: this.declaredAt, declaredBy: this.declaredBy, detectedAt: this.detectedAt,
      impactAt: this.impactAt, fixAppliedAt: this.fixAppliedAt,
      timeline: this.timeline, findings: this.findings, statusPosts: this.statusPosts,
      postmortem: this.postmortem, jamieMeetingId: this.jamieMeetingId,
      skippedInvestigation: this.skippedInvestigation,
      series: this.series, deploys: this.deploys,
      source: { id: this.source.id, label: this.source.label, simulated: this.source.simulated },
    };
  }

  // Tools for one agent; add_finding needs to know who is speaking.
  mcpServer(agentId: string, role: string) {
    const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
    const failure = (err: unknown) => ({ ...text((err as Error).message), isError: true });
    const by = `${role} (agent ${agentId})`;
    const metricNames = this.source.metrics.map((m) => m.name) as [string, ...string[]];
    const known = () => (this.services.length ? ` Services: ${this.services.join(", ")}.` : "");
    return createSdkMcpServer({
      name: MCP_NAME,
      version: "1.0.0",
      tools: [
        tool("list_services", "List the production services.", {}, async () => {
          try { return text((await this.source.services()).join("\n")); }
          catch (err) { return failure(err); }
        }),
        tool(
          "query_logs",
          `Read recent log lines from one service, newest last.${known()}`,
          { service: z.string(), since_minutes: z.number().min(1).max(240).default(15), contains: z.string().optional() },
          async ({ service, since_minutes, contains }) => {
            try {
              await assertService(this.source, service);
              const lines = await this.source.logs(service, since_minutes, contains);
              return text(lines.length ? lines.join("\n") : "(no matching log lines)");
            } catch (err) { return failure(err); }
          },
        ),
        tool(
          "get_metrics",
          `Get a metric for one service over a window. Metrics: ${this.source.metrics.map((m) => m.description).join(", ")}.${known()}`,
          { service: z.string(), metric: z.enum(metricNames), window_minutes: z.number().min(5).max(240).default(30) },
          async ({ service, metric, window_minutes }) => {
            try {
              await assertService(this.source, service);
              assertMetric(this.source, metric);
              const pts = await this.source.series(service, metric, window_minutes);
              if (!pts.length) return text("(no data points in this window)");
              const step = Math.max(1, Math.floor(pts.length / 20));
              return text(
                pts
                  .filter((_, i) => i % step === 0 || i === pts.length - 1)
                  .map((p) => `${new Date(p.t).toISOString().slice(11, 19)}  ${p.v.toFixed(1)}`)
                  .join("\n"),
              );
            } catch (err) { return failure(err); }
          },
        ),
        tool("list_deploys", "List recent deploys and config changes, newest first.", {}, async () => {
          try {
            const deploys = await this.source.deploys();
            return text(
              deploys
                .sort((a, b) => b.at - a.at)
                .map((d) => `#${d.id}  ${new Date(d.at).toISOString().slice(11, 19)}  ${d.service.padEnd(13)} ${d.author.padEnd(14)} ${d.message}${d.rolledBackAt ? "  (rolled back)" : ""}`)
                .join("\n") || "(no deploys)",
            );
          } catch (err) { return failure(err); }
        }),
        tool("get_deploy", "Show the diff of one deploy.", { deploy_id: z.string() }, async ({ deploy_id }) => {
          try {
            const d = (await this.source.deploys()).find((x) => x.id === deploy_id.replace("#", ""));
            return text(d ? `#${d.id} ${d.service} by ${d.author}: ${d.message}\n\n${d.diff}` : `No deploy #${deploy_id}`);
          } catch (err) { return failure(err); }
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
          this.log("finding", finding, by);
          return text("Recorded.");
        }),
        tool("read_findings", "Read everything the team has found so far.", {}, async () =>
          text(this.findings.length ? this.findings.map((f) => `[${f.role}] ${f.text}`).join("\n") : "No findings yet."),
        ),
        tool("rollback_deploy", "Roll back a deploy. Requires the incident commander's approval.", { deploy_id: z.string() }, async ({ deploy_id }) => {
          try { return text((await this.rollback(deploy_id, by)).message); }
          catch (err) { return failure(err); }
        }),
        tool("restart_service", "Restart a service's pods. Requires approval.", { service: z.string() }, async ({ service }) => {
          try {
            await assertService(this.source, service);
            const result = await this.source.restart(service);
            this.log("action", result.message, by);
            return text(result.message);
          } catch (err) { return failure(err); }
        }),
        tool(
          "post_status_update",
          "Post a customer-facing update to the public status page. Requires approval.",
          { status: z.enum(["investigating", "identified", "monitoring", "resolved"]), message: z.string() },
          async ({ status, message }) => {
            try {
              const result = await this.source.postStatus(status, message);
              if (!result.ok) return { ...text(result.message), isError: true };
              this.statusPosts.push({ at: Date.now(), status, message });
              this.log("statuspage", `[${status}] ${message}`, by);
              return text(result.message);
            } catch (err) { return failure(err); }
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
