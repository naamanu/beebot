import { useState } from "react";
import { ArrowLeft, Copy } from "lucide-react";
import { toast } from "sonner";
import type { SpanRow } from "../../../server/types.ts";
import { Button } from "@/components/ui/button";
import { Dot, Pill } from "@/components/pill";
import { Markdown } from "@/components/markdown";
import { useNow } from "@/hooks/use-now";
import { navigate } from "@/hooks/use-route";
import { useRun } from "@/lib/api";
import { formatCost, formatPercent, formatTokens } from "@/lib/format";
import { SPAN_KIND_STYLE, formatDuration } from "@/lib/spans";
import { RunStatusPill } from "./run-status";
import { Waterfall } from "./waterfall";

export function RunDetail({ id }: { id: string }) {
  const { data, error, isLoading } = useRun(id);
  const [selected, setSelected] = useState<string | null>(null);
  const live = data?.run.status === "running";
  const now = useNow(1000, live);

  if (isLoading) return <Shell>Loading run…</Shell>;
  if (error || !data) return <Shell>Run not found.</Shell>;

  const { run, spans } = data;
  const end = run.endedAt ?? now;
  // The router vote happens just before the run starts: include it.
  const start = Math.min(run.startedAt, ...spans.map((s) => s.startedAt));
  const span = spans.find((s) => s.id === selected) ?? spans.find((s) => s.kind === "invoke_agent") ?? spans[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <header className="flex shrink-0 flex-col gap-3 rounded-xl bg-card px-5 py-4 ring-1 ring-foreground/10">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon-sm" onClick={() => navigate("/runs")} aria-label="Back to all runs">
            <ArrowLeft />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="line-clamp-2 text-xl leading-tight">{run.task}</h1>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              agent-{run.agentId} · {run.model} · started {new Date(run.startedAt).toLocaleString()}
              {run.parentRunId && (
                <>
                  {" · "}
                  <button className="underline underline-offset-2 hover:text-foreground" onClick={() => navigate(`/runs/${run.parentRunId}`)}>
                    follow-up to previous run
                  </button>
                </>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-10">
          <RunStatusPill status={run.status} />
          <Pill>{formatDuration(end - run.startedAt)}</Pill>
          <Pill>{formatCost(run.costUsd)}</Pill>
          <Pill>
            {formatTokens(run.inputTokens + run.cacheReadTokens)} → {formatTokens(run.outputTokens)} tok
          </Pill>
          {run.cacheReadTokens > 0 && <Pill>{formatTokens(run.cacheReadTokens)} cache read</Pill>}
          {run.numTurns !== null && <Pill>{run.numTurns} turns</Pill>}
          <Pill>
            {run.toolCalls} tools{run.toolErrors > 0 && ` · ${run.toolErrors} failed`}
          </Pill>
          {run.steers > 0 && <Pill>{run.steers} steers</Pill>}
          {run.sessionId && (
            <Pill
              className="cursor-pointer hover:bg-secondary"
              onClick={() => {
                void navigator.clipboard.writeText(run.sessionId!);
                toast("Session ID copied");
              }}
              title="Copy the Claude session ID"
            >
              session {run.sessionId.slice(0, 8)} <Copy className="size-3" />
            </Pill>
          )}
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_400px]">
        <section className="flex min-h-0 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          <Waterfall spans={spans} start={start} end={end} selected={span?.id ?? null} onSelect={setSelected} />
        </section>
        <aside className="flex min-h-0 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {span ? <SpanPanel span={span} runStart={run.startedAt} now={now} /> : <p className="p-4 text-sm text-muted-foreground">No spans yet.</p>}
        </aside>
      </div>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="grid flex-1 place-items-center rounded-xl bg-card text-sm text-muted-foreground ring-1 ring-foreground/10">{children}</div>;
}

function SpanPanel({ span, runStart, now }: { span: SpanRow; runStart: number; now: number }) {
  const a = span.attrs as Record<string, unknown>;
  const dur = (span.endedAt ?? now) - span.startedAt;
  const style = SPAN_KIND_STYLE[span.kind];

  const rows: [string, string][] = [
    ["Kind", `${style.label} (${span.kind})`],
    ["Starts at", `+${formatDuration(span.startedAt - runStart)}`],
    ["Duration", span.endedAt ? formatDuration(dur) : "in progress"],
    ["Status", span.status],
  ];
  if (typeof a.model === "string") rows.push(["Model", a.model]);
  if (typeof a.inputTokens === "number") rows.push(["Input tokens", `${a.inputTokens} (+${a.cacheReadTokens ?? 0} cache read, +${a.cacheWriteTokens ?? 0} cache write)`]);
  if (span.kind === "chat") rows.push(["Output tokens", "counted per run (see header)"]);
  if (typeof a.outputTokens === "number") rows.push(["Output tokens", String(a.outputTokens)]);
  if (typeof a.costUsd === "number") rows.push(["Cost", formatCost(a.costUsd)]);
  if (typeof a.stopReason === "string") rows.push(["Stop reason", a.stopReason]);
  if (typeof a.confidence === "number") rows.push(["Agreement", formatPercent(a.confidence)]);
  if (typeof a.action === "string") rows.push(["Action", a.action]);
  if (typeof a.workspace === "string") rows.push(["Worktree", a.workspace]);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Dot className={style.dot} />
        <h2 className="truncate text-base">{span.name}</h2>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">{style.label}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 [scrollbar-width:thin]">
        {span.detail && <p className="mb-3 font-mono text-xs break-words text-muted-foreground">{span.detail}</p>}
        <dl className="mb-4 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="font-mono break-words">{v}</dd>
            </div>
          ))}
        </dl>

        {Array.isArray(a.votes) && (
          <Block title="Votes">
            <ul className="space-y-1 font-mono text-xs">
              {(a.votes as { target: string; intent: string; count: number }[]).map((v, i) => (
                <li key={i}>
                  {v.target} · {v.intent} · {v.count}
                </li>
              ))}
            </ul>
          </Block>
        )}
        {typeof a.instruction === "string" && a.instruction && <Block title="Instruction">{a.instruction}</Block>}
        {typeof a.input === "string" && (
          <Block title="Input">
            <Pre>{a.input}</Pre>
          </Block>
        )}
        {typeof a.output === "string" && a.output && (
          <Block title="Output">{span.kind === "chat" ? <Markdown>{a.output}</Markdown> : <Pre>{a.output}</Pre>}</Block>
        )}
      </div>
    </>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <h3 className="mb-1.5 text-xs text-muted-foreground">{title}</h3>
      <div className="text-[13px]">{children}</div>
    </section>
  );
}

function Pre({ children }: { children: string }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">
      {children}
    </pre>
  );
}
