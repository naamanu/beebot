import { FileText, Siren } from "lucide-react";
import type { IncidentStatus, IncidentView } from "../../../server/types.ts";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Pill } from "@/components/pill";
import { useNow } from "@/hooks/use-now";
import { navigate } from "@/hooks/use-route";
import { formatDuration } from "@/lib/spans";
import { useTower } from "@/lib/store";
import { ErrorRateChart } from "./error-rate-chart";

const STATUSES: IncidentStatus[] = ["investigating", "identified", "mitigated", "resolved"];

// inline: inside a task whose header already shows the title.
export function IncidentBar({ incident, inline = false }: { incident: IncidentView; inline?: boolean }) {
  const send = useTower((s) => s.send);
  const open = incident.status !== "resolved";
  const now = useNow(1000, open);
  const end = incident.mitigatedAt ?? now;

  return (
    <section className="flex shrink-0 flex-wrap items-center gap-x-6 gap-y-3 rounded-xl bg-card px-5 py-3.5 ring-1 ring-foreground/10">
      <div className="flex min-w-0 items-center gap-3">
        {!inline && (
          <div className={`grid size-9 shrink-0 place-items-center rounded-lg ${open ? "bg-span-agent text-white" : "bg-secondary"}`}>
            <Siren className="size-4" />
          </div>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Pill className="border-span-agent/40 bg-span-agent/10 text-span-agent">{incident.severity}</Pill>
            {!inline && <h2 className="truncate text-lg leading-tight">{incident.title}</h2>}
          </div>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            impact {formatDuration(end - incident.impactAt)}
            {incident.mitigatedAt ? " (mitigated)" : ""} · declared {formatDuration(now - incident.declaredAt)} ago
          </p>
        </div>
      </div>

      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={incident.status}
        onValueChange={(v) => v && send({ type: "incident_status", status: v as IncidentStatus })}
        aria-label="Incident status"
      >
        {STATUSES.map((s) => (
          <ToggleGroupItem key={s} value={s} className="px-2.5 text-xs capitalize">
            {s}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <div className="ml-auto flex items-center gap-5">
        <ErrorRateChart incident={incident} />
        <Button variant="outline" size="sm" onClick={() => navigate("/postmortem")}>
          <FileText data-icon="inline-start" /> Postmortem
        </Button>
      </div>
    </section>
  );
}
