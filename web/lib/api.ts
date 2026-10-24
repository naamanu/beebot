import { QueryClient, useQuery } from "@tanstack/react-query";
import type { RunDetail, RunRow, RunsQuery, TelemetrySummary } from "../../server/types.ts";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } },
});

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

// Everything under "telemetry" is refetched when the server says traces changed.
export function useSummary() {
  return useQuery({ queryKey: ["telemetry", "summary"], queryFn: () => get<TelemetrySummary>("/api/summary") });
}

export function useRuns(q: RunsQuery) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") params.set(k, String(v));
  return useQuery({
    queryKey: ["telemetry", "runs", q],
    queryFn: () => get<RunRow[]>(`/api/runs?${params}`),
    placeholderData: (prev) => prev, // keep the table steady while filters change
  });
}

export function useRun(id: string) {
  return useQuery({ queryKey: ["telemetry", "run", id], queryFn: () => get<RunDetail>(`/api/runs/${id}`) });
}

export function invalidateTelemetry(): void {
  void queryClient.invalidateQueries({ queryKey: ["telemetry"] });
}
