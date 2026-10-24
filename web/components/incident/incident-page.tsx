import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowLeft, CheckCircle2, Copy, Download, Loader2, RotateCcw, Waypoints, XCircle } from "lucide-react";
import { toast } from "sonner";
import type { TaskView } from "../../../server/types.ts";
import { Button } from "@/components/ui/button";
import { Dot } from "@/components/pill";
import { TaskDetail } from "@/components/tasks/task-detail";
import { useNow } from "@/hooks/use-now";
import { navigate } from "@/hooks/use-route";
import { plainIncidentStatus } from "@/lib/incident-status";
import { formatDuration } from "@/lib/spans";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

const TONE: Record<string, string> = {
  bad: "bg-span-error/10 text-span-error ring-span-error/30",
  waiting: "bg-span-http/15 text-span-http ring-span-http/40",
  recovering: "bg-span-workflow/10 text-span-workflow ring-span-workflow/30",
  good: "bg-span-tool/10 text-span-tool ring-span-tool/30",
};

// One incident, full screen: what's happening now, what happened, and the
// write-up. Status reads from what is going on; nobody has to set it.
export function IncidentPage({ task }: { task: TaskView }) {
  const incident = useTower((s) => s.incident)!;
  const agents = useTower((s) => s.agents);
  const send = useTower((s) => s.send);
  const connected = useTower((s) => s.connected);
  const setShowIncident = useTower((s) => s.setShowIncident);
  const [tab, setTab] = useState<"live" | "timeline" | "postmortem">("live");
  const open = incident.status !== "resolved";
  const now = useNow(1000, open);
  const proposals = useTower((s) => s.proposals);
  const status = plainIncidentStatus(incident, agents, proposals.some((p) => p.action?.type === "rollback"));
  const early = open && incident.fixAppliedAt === null;

  return (
    <article className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <Button variant="ghost" size="icon-sm" onClick={() => setShowIncident(false)} aria-label="Back to production health">
          <ArrowLeft />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl leading-tight">{incident.title}</h1>
          <p className="font-mono text-[11.5px] text-muted-foreground">
            {incident.declaredBy === "watchtower" ? "Noticed by the tower" : "Declared by you"} · customers affected{" "}
            {formatDuration((incident.mitigatedAt ?? (open ? now : incident.timeline.at(-1)?.at ?? now)) - incident.impactAt)}
          </p>
        </div>
        <span className={cn("inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium ring-1", TONE[status.tone])}>
          <Dot className={cn(status.tone === "good" ? "bg-span-tool" : status.tone === "waiting" ? "animate-pulse bg-span-http" : status.tone === "recovering" ? "bg-span-workflow" : "animate-pulse bg-span-error")} />
          {status.label}
        </span>
        {early && (
          <Button variant="outline" size="sm" disabled={!connected} onClick={() => send({ type: "stand_down" })} title="Call it off as a false alarm">
            <XCircle data-icon="inline-start" /> Stand down
          </Button>
        )}
        {open && !early && (
          <Button size="sm" disabled={!connected} onClick={() => send({ type: "incident_status", status: "resolved" })}>
            <CheckCircle2 data-icon="inline-start" /> Resolve
          </Button>
        )}
      </header>

      <nav className="flex gap-1 border-b border-border px-4" aria-label="Incident views">
        {(["live", "timeline", "postmortem"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            aria-current={tab === t ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2.5 text-sm capitalize",
              tab === t ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
            {t === "postmortem" && incident.postmortemState === "writing" && <Loader2 className="ml-1.5 inline size-3.5 animate-spin" />}
            {t === "postmortem" && incident.postmortemState === "ready" && <Dot className="ml-1.5 bg-span-tool" />}
          </button>
        ))}
      </nav>

      {tab === "live" && (
        <div className="flex min-h-0 flex-1 [&>article]:rounded-none [&>article]:ring-0">
          <TaskDetail task={task} embedded />
        </div>
      )}
      {tab === "timeline" && <Timeline />}
      {tab === "postmortem" && <Postmortem />}
    </article>
  );
}

const KIND_DOT: Record<string, string> = {
  declared: "bg-span-error",
  status: "bg-foreground/50",
  finding: "bg-span-chat",
  action: "bg-span-tool",
  approval: "bg-span-http",
  statuspage: "bg-span-workflow",
  instruction: "bg-span-http",
};

// Everything that happened, in order: who said, found, approved and did what.
function Timeline() {
  const incident = useTower((s) => s.incident)!;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 [scrollbar-width:thin]">
      <ol className="relative mx-auto flex max-w-3xl flex-col gap-3 border-l border-border pl-6">
        {incident.timeline.map((e, i) => (
          <li key={`${e.at}-${i}`} className="relative">
            <Dot className={cn("absolute top-[7px] -left-[28.5px] ring-4 ring-card", KIND_DOT[e.kind] ?? "bg-foreground/40")} />
            <p className="font-mono text-[11.5px] text-muted-foreground">
              {new Date(e.at).toLocaleTimeString()} · {e.by}
            </p>
            <p className="text-[14px] leading-snug">{e.text}</p>
          </li>
        ))}
      </ol>
      <div className="mx-auto mt-6 max-w-3xl">
        <Button variant="ghost" size="sm" onClick={() => navigate("/runs")}>
          <Waypoints data-icon="inline-start" /> Every model and tool call, in Activity
        </Button>
      </div>
    </div>
  );
}

// Written by itself when the incident is resolved.
function Postmortem() {
  const incident = useTower((s) => s.incident)!;
  const { data, refetch } = useQuery({
    queryKey: ["postmortem", incident.id, incident.postmortemState],
    queryFn: async () => (await (await fetch("/api/incident/postmortem")).json()) as { markdown: string | null },
    enabled: incident.postmortemState === "ready",
  });
  const write = async () => {
    const res = await fetch("/api/incident/postmortem", { method: "POST" });
    if (!res.ok) toast.error("The postmortem could not be written. Try again.");
    else void refetch();
  };

  if (incident.postmortemState === "writing") {
    return (
      <p className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Writing the postmortem from the timeline and every agent’s work…
      </p>
    );
  }
  if (incident.postmortemState !== "ready" || !data?.markdown) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="max-w-md text-sm text-muted-foreground">
          {incident.postmortemState === "error"
            ? "The postmortem couldn’t be written."
            : incident.status === "resolved"
              ? "No postmortem for this one (it was stood down)."
              : "The postmortem writes itself when the incident is resolved."}
        </p>
        <Button size="sm" variant="outline" onClick={() => void write()}>
          <RotateCcw data-icon="inline-start" /> Write it now
        </Button>
      </div>
    );
  }
  const markdown = data.markdown;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6 [scrollbar-width:thin]">
      <div className="mx-auto mb-4 flex max-w-3xl justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(markdown);
            toast("Postmortem copied as Markdown");
          }}
        >
          <Copy data-icon="inline-start" /> Copy
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
            Object.assign(document.createElement("a"), { href: url, download: `${incident.id}-postmortem.md` }).click();
            URL.revokeObjectURL(url);
          }}
        >
          <Download data-icon="inline-start" /> Download .md
        </Button>
      </div>
      <div className="prose-postmortem mx-auto max-w-3xl">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
      </div>
    </div>
  );
}
