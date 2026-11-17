import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IncidentStatus } from "../types.ts";
import type { IncidentRecord } from "./incident.ts";

export interface IncidentSummary {
  id: string;
  title: string;
  severity: "SEV1" | "SEV2";
  status: IncidentStatus;
  declaredAt: number;
  declaredBy: string;
  updatedAt: number;
  hasPostmortem: boolean;
  findings: number;
  source: string;
}

// Every incident, kept across restarts. One row per incident holding the full
// record as JSON; the columns exist for listing without parsing every row.
export class IncidentStore {
  private db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS incidents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        declared_at INTEGER NOT NULL,
        declared_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        record TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS incidents_declared ON incidents (declared_at DESC);
    `);
  }

  save(record: IncidentRecord, now = Date.now()): void {
    this.db
      .prepare(`
        INSERT INTO incidents (id, title, severity, status, declared_at, declared_by, updated_at, record)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, record = excluded.record
      `)
      .run(record.id, record.title, record.severity, record.status, record.declaredAt, record.declaredBy, now, JSON.stringify(record));
  }

  get(id: string): IncidentRecord | null {
    const row = this.db.prepare("SELECT record FROM incidents WHERE id = ?").get(id) as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as IncidentRecord) : null;
  }

  // The most recent incident that was still open when the server stopped.
  lastOpen(): IncidentRecord | null {
    const row = this.db.prepare("SELECT record FROM incidents WHERE status != 'resolved' ORDER BY declared_at DESC LIMIT 1").get() as { record: string } | undefined;
    return row ? (JSON.parse(row.record) as IncidentRecord) : null;
  }

  list(limit = 50): IncidentSummary[] {
    const rows = this.db.prepare("SELECT updated_at, record FROM incidents ORDER BY declared_at DESC LIMIT ?").all(limit) as { updated_at: number; record: string }[];
    return rows.map(({ updated_at, record }) => {
      const r = JSON.parse(record) as IncidentRecord;
      return {
        id: r.id, title: r.title, severity: r.severity, status: r.status,
        declaredAt: r.declaredAt, declaredBy: r.declaredBy, updatedAt: updated_at,
        hasPostmortem: !!r.postmortem, findings: r.findings.length, source: r.source.label,
      };
    });
  }

  close(): void {
    this.db.close();
  }
}
