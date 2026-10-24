import { useEffect, useMemo, useRef } from "react";
import type { TaskView } from "../../server/types.ts";
import { buildTasks } from "../../server/tasks.ts";
import { useTower } from "@/lib/store";

// Tasks are derived from agents, missions and the incident on the client, so
// they update with every agent event, not only on full state pushes.
export function useTasks(): TaskView[] {
  const agents = useTower((s) => s.agents);
  const missions = useTower((s) => s.missions);
  const incident = useTower((s) => s.incident);
  return useMemo(() => buildTasks(agents, missions, incident), [agents, missions, incident]);
}

export function useSelectedTask(): TaskView | null {
  const tasks = useTasks();
  const id = useTower((s) => s.selectedTaskId);
  return tasks.find((t) => t.id === id) ?? null;
}

// When new work we just sent turns into a task, open it.
export function useAutoSelectNewTasks(tasks: TaskView[]): void {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    const { lastSentAt, selectTask } = useTower.getState();
    if (seen.current) {
      const fresh = tasks.find((t) => !seen.current!.has(t.id) && Date.now() - lastSentAt < 30_000 && t.createdAt >= lastSentAt - 2000);
      if (fresh) selectTask(fresh.id);
    }
    seen.current = new Set(tasks.map((t) => t.id));
  }, [tasks]);
}
