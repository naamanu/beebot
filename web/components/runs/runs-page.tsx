import { useDeferredValue, useState } from "react";
import { Search } from "lucide-react";
import type { RunStatus } from "../../../server/types.ts";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useNow } from "@/hooks/use-now";
import { navigate } from "@/hooks/use-route";
import { useRuns, useSummary } from "@/lib/api";
import { formatAgo, formatCost, formatPercent, formatTokens } from "@/lib/format";
import { formatDuration } from "@/lib/spans";
import { CostChart } from "./cost-chart";
import { RunStatusPill } from "./run-status";

const STATUSES: (RunStatus | "all")[] = ["all", "running", "success", "error", "stopped", "interrupted"];

export function RunsPage({ taskId = null }: { taskId?: string | null }) {
  const [status, setStatus] = useState<RunStatus | "all">("all");
  const [agent, setAgent] = useState("all");
  const [search, setSearch] = useState("");
  const q = useDeferredValue(search);
  const summary = useSummary().data;
  const runs =
    useRuns({ status: status === "all" ? undefined : status, agent: agent === "all" ? undefined : agent, q, taskId: taskId ?? undefined }).data ?? [];
  const allRuns = useRuns({}).data ?? [];
  const agentIds = [...new Set(allRuns.map((r) => r.agentId))].sort((a, b) => Number(a) - Number(b));
  const now = useNow(5000);

  const finished = summary ? summary.success + summary.failed : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* KPI tiles */}
      <section className="grid shrink-0 grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Runs" value={String(summary?.runs ?? 0)} sub={`${summary?.running ?? 0} running`} />
        <Stat
          label="Success rate"
          value={finished ? formatPercent(summary!.success / finished) : "–"}
          sub={`${summary?.success ?? 0} of ${finished} finished`}
        />
        <Stat
          label="Spend"
          value={formatCost((summary?.costUsd ?? 0) + (summary?.routerCostUsd ?? 0))}
          sub={`agents ${formatCost(summary?.costUsd ?? 0)} · router ${formatCost(summary?.routerCostUsd ?? 0)}`}
        />
        <Stat
          label="Tokens"
          value={`${formatTokens(summary?.inputTokens ?? 0)} → ${formatTokens(summary?.outputTokens ?? 0)}`}
          sub={`${formatTokens(summary?.cacheReadTokens ?? 0)} cache read`}
        />
        <Stat label="Duration p50" value={formatDuration(summary?.p50Ms ?? 0)} sub={`p95 ${formatDuration(summary?.p95Ms ?? 0)}`} />
        <Stat
          label="Tool calls"
          value={String(summary?.toolCalls ?? 0)}
          sub={`${summary?.toolErrors ?? 0} errors · ${summary?.steers ?? 0} steers`}
        />
        <Stat
          label="Router"
          value={`${summary?.routerDecisions ?? 0} decisions`}
          sub={`${formatPercent(summary?.routerAvgConfidence ?? 0)} avg agreement · ${summary?.routerClarifications ?? 0} asked back`}
        />
      </section>

      <section className="grid min-h-0 flex-1 grid-rows-[200px_minmax(0,1fr)] gap-3">
        <div className="flex min-h-0 flex-col rounded-xl bg-card p-4 ring-1 ring-foreground/10">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-base">Spend per run</h2>
            <span className="text-xs text-muted-foreground">last {Math.min(allRuns.length, 48)} runs · click a bar to open it</span>
          </div>
          <div className="min-h-0 flex-1">
            <CostChart runs={allRuns} />
          </div>
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {/* Filters: one row, above the data */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <h2 className="mr-2 pl-1 text-base">{taskId ? "Runs for this task" : "All runs"}</h2>
            {taskId && (
              <button className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => navigate("/runs")}>
                show all
              </button>
            )}
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={status}
              onValueChange={(v) => v && setStatus(v as RunStatus | "all")}
            >
              {STATUSES.map((s) => (
                <ToggleGroupItem key={s} value={s} className="px-2.5 text-xs capitalize">
                  {s}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Select value={agent} onValueChange={setAgent}>
              <SelectTrigger size="sm" className="w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {agentIds.map((id) => (
                  <SelectItem key={id} value={id}>
                    agent-{id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative ml-auto w-64">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tasks and results" className="h-8 pl-8 text-xs" />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead>Task</TableHead>
                  <TableHead className="w-24">Agent</TableHead>
                  <TableHead className="w-28">Started</TableHead>
                  <TableHead className="w-24 text-right">Duration</TableHead>
                  <TableHead className="w-20 text-right">Tools</TableHead>
                  <TableHead className="w-20 text-right">Steers</TableHead>
                  <TableHead className="w-32 text-right">Tokens</TableHead>
                  <TableHead className="w-24 text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                      No runs match. Runs appear here as soon as an agent is given work.
                    </TableCell>
                  </TableRow>
                )}
                {runs.map((r) => (
                  <TableRow key={r.id} className="cursor-pointer" onClick={() => navigate(`/runs/${r.id}`)}>
                    <TableCell>
                      <RunStatusPill status={r.status} />
                    </TableCell>
                    <TableCell className="max-w-0">
                      <p className="truncate text-[13px]">
                        {r.parentRunId && <span className="mr-1.5 font-mono text-[11px] text-muted-foreground">↳ follow-up</span>}
                        {r.task}
                      </p>
                    </TableCell>
                    <TableCell className="font-mono text-xs">agent-{r.agentId}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatAgo(r.startedAt, now)}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {formatDuration((r.endedAt ?? now) - r.startedAt)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {r.toolCalls}
                      {r.toolErrors > 0 && <span className="text-span-error"> ({r.toolErrors}✕)</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{r.steers}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">
                      {formatTokens(r.inputTokens + r.cacheReadTokens)} → {formatTokens(r.outputTokens)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{formatCost(r.costUsd)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-card px-4 py-3 ring-1 ring-foreground/10">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate font-heading text-xl tabular-nums">{value}</span>
      <span className="truncate font-mono text-[11px] text-muted-foreground">{sub}</span>
    </div>
  );
}
