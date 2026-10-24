// Jamie (meetjamie.ai) meeting notes: past incident calls as context for the
// agents, and the war-room call as input to the postmortem.
// Docs: https://docs.meetjamie.ai/developers/api/api.md

const BASE = "https://beta-api.meetjamie.ai/v1/me";

export interface JamieMeetingSummary {
  id: string;
  title: string;
  startTime: string;
  endTime: string | null;
}

export interface JamieMeeting extends JamieMeetingSummary {
  summary: { markdown: string; short: string };
  transcript: string;
  participants: { name: string; email: string | null }[];
  tasks: { content: string; completed: boolean; assignee: { name: string | null; email: string | null } | null }[];
}

export interface JamieSearchHit {
  meetingId: string;
  meetingTitle: string | null;
  meetingDate: string;
  text: string;
}

export class Jamie {
  constructor(private apiKey: string | undefined) {}

  get configured(): boolean {
    return !!this.apiKey;
  }

  private async call<T>(procedure: string, input: Record<string, unknown>): Promise<T> {
    if (!this.apiKey) throw new Error("JAMIE_API_KEY is not set");
    const url = `${BASE}/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
    const res = await fetch(url, { headers: { "x-api-key": this.apiKey } });
    if (!res.ok) throw new Error(`Jamie ${procedure} failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { result: { data: { json: T } } };
    return body.result.data.json;
  }

  async search(query: string): Promise<JamieSearchHit[]> {
    const { results } = await this.call<{ results: JamieSearchHit[] }>("meetings.search", { query });
    return results;
  }

  async list(limit = 10): Promise<JamieMeetingSummary[]> {
    const { meetings } = await this.call<{ meetings: (JamieMeetingSummary & { generatedTitle: string | null })[] }>("meetings.list", { limit });
    return meetings.map((m) => ({ id: m.id, title: m.generatedTitle || m.title, startTime: m.startTime, endTime: m.endTime }));
  }

  async get(meetingId: string): Promise<JamieMeeting> {
    return this.call<JamieMeeting>("meetings.get", { meetingId });
  }
}

// Used when no Jamie key is configured, so the demo still has history to find.
export const SAMPLE_PAST_INCIDENTS: JamieSearchHit[] = [
  {
    meetingId: "sample-2026-08-12",
    meetingTitle: "Incident review: payments outage (Aug 12)",
    meetingDate: "2026-08-12",
    text:
      "Root cause was DB connection pool exhaustion on payments-api after a config change lowered the pool size. " +
      "Restarts only helped for a minute each time. Rolling back the config fixed it within a minute. " +
      "Action items: alert on pool saturation above 80%, require review for production pool settings.",
  },
  {
    meetingId: "sample-2026-06-03",
    meetingTitle: "Incident review: slow storefront (Jun 3)",
    meetingDate: "2026-06-03",
    text:
      "CDN cache hit ratio dropped after a TTL change. Origin load went up but checkout was unaffected; " +
      "the cache refilled within ten minutes. Decided cache dips alone are not page-worthy.",
  },
];
