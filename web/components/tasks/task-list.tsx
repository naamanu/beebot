import { useEffect, useState } from "react";
import { Code2, Plus, Search, Siren, Sparkles, X } from "lucide-react";
import type { TaskStatus, TaskView } from "../../../server/types.ts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Input } from "@/components/ui/input";
import { useNow } from "@/hooks/use-now";
import { formatAgo } from "@/lib/format";
import { agentName } from "@/lib/spans";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";
import { TASK_STATUS, TaskStatusIcon } from "./task-status";

const GROUPS: { label: string; statuses: TaskStatus[] }[] = [
  { label: "Needs you", statuses: ["needs_you", "ready"] },
  { label: "In progress", statuses: ["planning", "working"] },
  { label: "Finished", statuses: ["done", "failed", "stopped"] },
];

const KIND_ICON = { general: Sparkles, coding: Code2, incident: Siren };

export function TaskList({ tasks }: { tasks: TaskView[] }) {
  const selected = useTower((s) => s.selectedTaskId);
  const selectTask = useTower((s) => s.selectTask);
  const agents = useTower((s) => s.agents);
  const setFocus = useTower((s) => s.setFocus);
  const now = useNow(30_000);
  const [search, setSearch] = useState("");
  const matching = tasks.filter((task) => `${task.title} ${task.request}`.toLowerCase().includes(search.trim().toLowerCase()));
  const newTask = () => {
    selectTask(null);
    document.querySelector<HTMLTextAreaElement>("[data-command-input]")?.focus();
  };

  // ⌘J / Ctrl+J: new task. Alt+↑/↓: move through tasks.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        selectTask(null);
        document.querySelector<HTMLTextAreaElement>("[data-command-input]")?.focus();
      }
      if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp") && tasks.length) {
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        const i = tasks.findIndex((t) => t.id === useTower.getState().selectedTaskId);
        const next = e.key === "ArrowDown" ? Math.min(tasks.length - 1, i + 1) : Math.max(0, i - 1);
        selectTask(tasks[next < 0 ? 0 : next]!.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tasks, selectTask]);

  return (
    <>
    <div className="flex shrink-0 items-center gap-2 md:hidden">
      <label htmlFor="mobile-task" className="sr-only">Selected task</label>
      <select
        id="mobile-task"
        value={selected ?? ""}
        onChange={(event) => selectTask(event.target.value || null)}
        className="h-10 min-w-0 flex-1 truncate rounded-lg border border-input bg-card px-3 text-sm focus-visible:outline-2 focus-visible:outline-ring"
      >
        <option value="">New task</option>
        {GROUPS.map((group) => {
          const items = tasks.filter((task) => group.statuses.includes(task.status));
          return items.length ? (
            <optgroup key={group.label} label={`${group.label} (${items.length})`}>
              {items.map((task) => <option key={task.id} value={task.id}>{TASK_STATUS[task.status].label} · {task.title}</option>)}
            </optgroup>
          ) : null;
        })}
      </select>
      <Button variant="outline" size="icon-lg" onClick={newTask} aria-label="New task"><Plus /></Button>
    </div>
    <nav className="hidden min-h-0 w-64 shrink-0 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10 md:flex xl:w-72" aria-label="Tasks">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <h2 className="pl-1 text-base">Tasks <span className="ml-1 font-mono text-xs text-muted-foreground">{tasks.length}</span></h2>
        <Button size="sm" variant={selected === null ? "default" : "outline"} onClick={newTask}>
          <Plus data-icon="inline-start" /> New
          <Kbd className={cn("ml-1", selected === null && "bg-primary-foreground/10 text-primary-foreground")}>⌘J</Kbd>
        </Button>
      </div>
      {tasks.length > 0 && (
        <div className="relative mx-3 mt-3 mb-1">
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-3.5 text-muted-foreground" />
          <Input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find a task…" aria-label="Search tasks" className="h-9 pr-8 pl-8 [&::-webkit-search-cancel-button]:appearance-none" />
          {search && <Button size="icon-xs" variant="ghost" className="absolute top-1.5 right-1" onClick={() => setSearch("")} aria-label="Clear task search"><X /></Button>}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-2 [scrollbar-width:thin]">
        {tasks.length === 0 && <p className="px-2 py-3 text-[13px] leading-relaxed text-muted-foreground">Your tasks will appear here. Start with a request or choose an example.</p>}
        {tasks.length > 0 && matching.length === 0 && (
          <div className="px-2 py-6 text-center text-sm">
            <p className="font-medium">No matching tasks</p>
            <p className="mt-1 break-words text-xs text-muted-foreground">Try another search or clear “{search}”.</p>
            <Button variant="link" size="sm" className="mt-2" onClick={() => setSearch("")}>Clear search</Button>
          </div>
        )}
        {GROUPS.map((g) => {
          const items = matching.filter((t) => g.statuses.includes(t.status));
          if (!items.length) return null;
          return (
            <section key={g.label} className="mb-3">
              <h3 className={cn("px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase", g.label === "Needs you" && "text-span-http")}>
                {g.label} · {items.length}
              </h3>
              <ul className="flex flex-col gap-0.5">
                {items.map((t) => {
                  const Kind = KIND_ICON[t.template];
                  return (
                    <li key={t.id}>
                      <button
                        onClick={() => selectTask(t.id)}
                        aria-current={selected === t.id ? "true" : undefined}
                        className={cn(
                          "flex w-full items-start gap-2.5 rounded-lg border border-transparent px-2 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring",
                          selected === t.id && "border-border bg-secondary hover:bg-secondary",
                        )}
                      >
                        <TaskStatusIcon status={t.status} className="mt-0.5" />
                        <span className="min-w-0 flex-1">
                          <span className="line-clamp-2 break-words text-[13.5px] leading-snug font-medium">{t.title}</span>
                          <span className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                            <Kind className="size-3" />
                            {t.needs[0]?.label ? <span className="truncate text-span-http">{t.needs[0].label}</span> : <span>{subtitle(t, now)}</span>}
                          </span>
                        </span>
                      </button>
                      {selected === t.id && t.agentIds.length > 0 && (
                        <ul className="mt-1 mb-2 ml-4 border-l border-border pl-2" aria-label={`Agents for ${t.title}`}>
                          {t.agentIds.flatMap((id) => {
                            const agent = agents.find((a) => a.id === id);
                            return agent ? [
                              <li key={id}>
                                <button onClick={() => setFocus(id)} className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
                                  <span className="min-w-0 flex-1 truncate">{agentName(agent)}</span>
                                  <span className="shrink-0 text-[10px] text-muted-foreground">{agent.status === "idle" ? "finished" : agent.status}</span>
                                </button>
                              </li>,
                            ] : [];
                          })}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </nav>
    </>
  );
}

function subtitle(t: TaskView, now: number): string {
  const agents = t.agentIds.length ? `${t.agentIds.length} agent${t.agentIds.length === 1 ? "" : "s"} · ` : "";
  return `${agents}${formatAgo(t.endedAt ?? t.createdAt, now)}`;
}
