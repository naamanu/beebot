import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { RouteVerdict, RunDetail, RunRow, RunStatus, RunsQuery, SpanKind, SpanRow, TelemetrySummary } from "./types.ts";

// Traces of every run, in a local SQLite file. A run is one stretch of work
// by one agent: from the instruction that started it until its result.
// Span kinds follow the OpenTelemetry GenAI names (invoke_agent, chat,
// execute_tool) so the data could be exported to any OTLP backend later.

export class Telemetry {
  private db: DatabaseSync;
  private listeners = new Set<() => void>();
  private notifyTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        task TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        api_ms INTEGER,
        num_turns INTEGER,
        cost_usd REAL NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        tool_calls INTEGER NOT NULL DEFAULT 0,
        tool_errors INTEGER NOT NULL DEFAULT 0,
        steers INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        workspace TEXT,
        session_id TEXT
      );
      CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at DESC);
      CREATE TABLE IF NOT EXISTS spans (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        status TEXT NOT NULL DEFAULT 'ok',
        attrs TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS spans_run ON spans(run_id, started_at);
      CREATE TABLE IF NOT EXISTS decisions (
        at INTEGER NOT NULL,
        utterance TEXT NOT NULL,
        target TEXT NOT NULL,
        intent TEXT NOT NULL,
        action TEXT NOT NULL,
        confidence REAL NOT NULL,
        ms INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL
      );
    `);
    // Added after the first version of the schema.
    for (const column of ["parent_run_id", "task_id"]) {
      try {
        this.db.exec(`ALTER TABLE runs ADD COLUMN ${column} TEXT`);
      } catch {
        // column already exists
      }
    }
  }

  // Called (throttled) whenever trace data changes, so the UI can refresh.
  onChange(fn: () => void): void {
    this.listeners.add(fn);
  }

  close(): void {
    clearTimeout(this.notifyTimer);
    this.listeners.clear();
    this.db.close();
  }

  private changed(): void {
    clearTimeout(this.notifyTimer);
    this.notifyTimer = setTimeout(() => this.listeners.forEach((fn) => fn()), 400);
  }

  // Runs left "running" by a server that died, and not resumed since.
  closeOrphans(keep: Set<string>): void {
    const running = this.db.prepare(`SELECT id FROM runs WHERE status = 'running'`).all() as { id: string }[];
    for (const { id } of running) {
      if (!keep.has(id)) this.finishRun(id, { status: "interrupted" });
    }
  }

  startRun(r: {
    taskId: string | null;
    agentId: string;
    task: string;
    model: string;
    workspace: string;
    sessionId: string | null;
    parentRunId: string | null;
  }): string {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO runs (id, agent_id, task, model, status, started_at, workspace, session_id, parent_run_id, task_id) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
      )
      .run(id, r.agentId, r.task, r.model, now, r.workspace, r.sessionId, r.parentRunId, r.taskId);
    this.changed();
    return id;
  }

  startSpan(runId: string, kind: SpanKind, name: string, detail = "", attrs: Record<string, unknown> = {}, startedAt = Date.now()): string {
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO spans (id, run_id, kind, name, detail, started_at, attrs) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, runId, kind, name, detail, startedAt, JSON.stringify(attrs));
    if (kind === "execute_tool") this.db.prepare(`UPDATE runs SET tool_calls = tool_calls + 1 WHERE id = ?`).run(runId);
    if (kind === "operator") this.db.prepare(`UPDATE runs SET steers = steers + 1 WHERE id = ?`).run(runId);
    this.changed();
    return id;
  }

  updateSpan(id: string, patch: { endedAt?: number; status?: "ok" | "error"; detail?: string; attrs?: Record<string, unknown> }): void {
    const row = this.db.prepare(`SELECT run_id, kind, status, attrs FROM spans WHERE id = ?`).get(id) as
      | { run_id: string; kind: SpanKind; status: string; attrs: string }
      | undefined;
    if (!row) return;
    const attrs = patch.attrs ? { ...JSON.parse(row.attrs), ...patch.attrs } : undefined;
    this.db
      .prepare(
        `UPDATE spans SET ended_at = COALESCE(?, ended_at), status = COALESCE(?, status), detail = COALESCE(?, detail), attrs = COALESCE(?, attrs) WHERE id = ?`,
      )
      .run(patch.endedAt ?? null, patch.status ?? null, patch.detail ?? null, attrs ? JSON.stringify(attrs) : null, id);
    if (row.kind === "execute_tool" && patch.status === "error" && row.status !== "error") {
      this.db.prepare(`UPDATE runs SET tool_errors = tool_errors + 1 WHERE id = ?`).run(row.run_id);
    }
    this.changed();
  }

  // A moment rather than a stretch of time: an operator instruction.
  point(runId: string, kind: SpanKind, name: string, detail: string, attrs: Record<string, unknown> = {}, startedAt = Date.now()): void {
    const id = this.startSpan(runId, kind, name, detail, attrs, startedAt);
    this.updateSpan(id, { endedAt: startedAt });
  }

  addUsage(runId: string, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): void {
    this.db
      .prepare(
        `UPDATE runs SET input_tokens = input_tokens + ?, output_tokens = output_tokens + ?, cache_read_tokens = cache_read_tokens + ?, cache_write_tokens = cache_write_tokens + ? WHERE id = ?`,
      )
      .run(u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, runId);
  }

  setUsage(runId: string, u: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }): void {
    this.db
      .prepare(`UPDATE runs SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ? WHERE id = ?`)
      .run(u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, runId);
  }

  setSession(runId: string, sessionId: string): void {
    this.db.prepare(`UPDATE runs SET session_id = COALESCE(session_id, ?) WHERE id = ?`).run(sessionId, runId);
  }

  finishRun(id: string, r: { status: RunStatus; costUsd?: number; apiMs?: number; numTurns?: number; result?: string }): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE runs SET status = ?, ended_at = ?, cost_usd = COALESCE(?, cost_usd), api_ms = COALESCE(?, api_ms), num_turns = COALESCE(?, num_turns), result = COALESCE(?, result) WHERE id = ?`,
      )
      .run(r.status, now, r.costUsd ?? null, r.apiMs ?? null, r.numTurns ?? null, r.result ?? null, id);
    // Close anything still open (e.g. a tool call cut off by a stop).
    this.db.prepare(`UPDATE spans SET ended_at = ? WHERE run_id = ? AND ended_at IS NULL`).run(now, id);
    this.changed();
  }

  recordDecision(v: RouteVerdict): void {
    this.db
      .prepare(`INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(Date.now(), v.utterance, v.target, v.intent, v.action, v.confidence, v.ms, v.usage.inputTokens, v.usage.outputTokens, v.usage.costUsd);
    this.changed();
  }

  // --- queries ---

  listRuns(q: RunsQuery): RunRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (q.status) {
      where.push("status = ?");
      args.push(q.status);
    }
    if (q.taskId) {
      where.push("task_id = ?");
      args.push(q.taskId);
    }
    if (q.agent) {
      where.push("agent_id = ?");
      args.push(q.agent);
    }
    if (q.q) {
      where.push("(task LIKE ? OR result LIKE ?)");
      args.push(`%${q.q}%`, `%${q.q}%`);
    }
    const sql = `SELECT * FROM runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...args, q.limit ?? 200) as Record<string, unknown>[]).map(toRun);
  }

  getRun(id: string): RunDetail | null {
    const run = this.db.prepare(`SELECT * FROM runs WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!run) return null;
    const spans = this.db.prepare(`SELECT * FROM spans WHERE run_id = ? ORDER BY started_at, rowid`).all(id) as Record<string, unknown>[];
    return { run: toRun(run), spans: spans.map(toSpan) };
  }

  summary(): TelemetrySummary {
    const router = this.db
      .prepare(`SELECT COUNT(*) AS n, SUM(cost_usd) AS cost, AVG(confidence) AS conf, SUM(action = 'clarify') AS clarify, AVG(ms) AS ms FROM decisions`)
      .get() as Record<string, number | null>;
    const agg = this.db
      .prepare(
        `SELECT COUNT(*) AS runs,
          SUM(status = 'running') AS running,
          SUM(status = 'success') AS success,
          SUM(status IN ('error', 'interrupted', 'stopped')) AS failed,
          SUM(cost_usd) AS cost, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
          SUM(cache_read_tokens) AS cache_read, SUM(tool_calls) AS tools, SUM(tool_errors) AS tool_errors, SUM(steers) AS steers
        FROM runs`,
      )
      .get() as Record<string, number | null>;
    const durations = (
      this.db.prepare(`SELECT ended_at - started_at AS d FROM runs WHERE ended_at IS NOT NULL ORDER BY d`).all() as { d: number }[]
    ).map((r) => r.d);
    const pct = (p: number) => (durations.length ? durations[Math.min(durations.length - 1, Math.floor(p * durations.length))]! : 0);
    return {
      runs: agg.runs ?? 0,
      running: agg.running ?? 0,
      success: agg.success ?? 0,
      failed: agg.failed ?? 0,
      costUsd: agg.cost ?? 0,
      routerCostUsd: router.cost ?? 0,
      routerDecisions: router.n ?? 0,
      routerAvgConfidence: router.conf ?? 0,
      routerClarifications: router.clarify ?? 0,
      routerAvgMs: router.ms ?? 0,
      inputTokens: agg.input ?? 0,
      outputTokens: agg.output ?? 0,
      cacheReadTokens: agg.cache_read ?? 0,
      toolCalls: agg.tools ?? 0,
      toolErrors: agg.tool_errors ?? 0,
      steers: agg.steers ?? 0,
      p50Ms: pct(0.5),
      p95Ms: pct(0.95),
    };
  }
}

function toRun(r: Record<string, unknown>): RunRow {
  return {
    id: r.id as string,
    agentId: r.agent_id as string,
    task: r.task as string,
    model: r.model as string,
    status: r.status as RunStatus,
    startedAt: r.started_at as number,
    endedAt: (r.ended_at as number | null) ?? null,
    apiMs: (r.api_ms as number | null) ?? null,
    numTurns: (r.num_turns as number | null) ?? null,
    costUsd: r.cost_usd as number,
    inputTokens: r.input_tokens as number,
    outputTokens: r.output_tokens as number,
    cacheReadTokens: r.cache_read_tokens as number,
    cacheWriteTokens: r.cache_write_tokens as number,
    toolCalls: r.tool_calls as number,
    toolErrors: r.tool_errors as number,
    steers: r.steers as number,
    result: (r.result as string | null) ?? null,
    workspace: (r.workspace as string | null) ?? null,
    sessionId: (r.session_id as string | null) ?? null,
    parentRunId: (r.parent_run_id as string | null) ?? null,
    taskId: (r.task_id as string | null) ?? null,
  };
}

function toSpan(s: Record<string, unknown>): SpanRow {
  return {
    id: s.id as string,
    runId: s.run_id as string,
    kind: s.kind as SpanKind,
    name: s.name as string,
    detail: s.detail as string,
    startedAt: s.started_at as number,
    endedAt: (s.ended_at as number | null) ?? null,
    status: s.status as "ok" | "error",
    attrs: JSON.parse(s.attrs as string),
  };
}
