import { hasUnconfirmedRecovery } from "@/lib/incident-status";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Copy, Download, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/pill";
import { navigate } from "@/hooks/use-route";
import { useTower } from "@/lib/store";
import { ProposalBanner } from "@/components/proposal-banner";
import { JamieNotesControls } from "./jamie-notes-controls";

export function PostmortemPage() {
  const incident = useTower((s) => s.incident);

  const existing = useQuery({
    queryKey: ["postmortem", incident?.id],
    queryFn: async () => (await (await fetch("/api/incident/postmortem")).json()) as { markdown: string | null },
    enabled: !!incident,
  });
  const generate = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/incident/postmortem", { method: "POST" });
      if (!res.ok) throw new Error((await res.json()).error);
      return (await res.json()) as { markdown: string };
    },
    onSuccess: () => void existing.refetch(),
    onError: (e) => toast.error(e.message),
  });

  if (!incident) {
    return (
      <div className="grid flex-1 place-items-center rounded-xl bg-card text-sm text-muted-foreground ring-1 ring-foreground/10">
        No incident in this session. Declare one from the Tower.
      </div>
    );
  }

  const markdown = generate.data?.markdown ?? existing.data?.markdown ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <ProposalBanner />
      <header className="flex shrink-0 flex-wrap items-center gap-3 rounded-xl bg-card px-5 py-4 ring-1 ring-foreground/10">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate("/")} aria-label="Back to the tower">
          <ArrowLeft />
        </Button>
        <div className="min-w-0">
          <h1 className="text-xl leading-tight">Postmortem: {incident.title}</h1>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">
            {incident.severity} · {hasUnconfirmedRecovery(incident) ? "closed with open questions" : incident.status} · {incident.timeline.length} timeline events · {incident.findings.length} findings
          </p>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <JamieNotesControls />
          <Button size="sm" disabled={generate.isPending} onClick={() => generate.mutate()}>
            {generate.isPending ? <Loader2 className="animate-spin" data-icon="inline-start" /> : <FileText data-icon="inline-start" />}
            {markdown ? "Regenerate" : "Generate postmortem"}
          </Button>
        </div>
      </header>

      <article className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-card px-8 py-6 ring-1 ring-foreground/10 [scrollbar-width:thin]">
        {incident.skippedInvestigation?.demoRecoveryAt !== undefined && <p role="status" className="mx-auto mb-4 max-w-3xl rounded-xl border border-span-tool/40 bg-span-tool/5 p-3 text-sm">Demo services reset to healthy. Open questions remain saved for follow-up.</p>}
        {hasUnconfirmedRecovery(incident) && <p role="status" className="mb-4 rounded-xl border border-span-http/40 bg-span-http/5 p-3 text-sm">Investigation closed with open questions. Production recovery remains unconfirmed.</p>}
        {generate.isPending && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Writing the postmortem from the timeline, the agents’ runs
            {incident.jamieMeetingId ? " and the call notes" : ""}…
          </p>
        )}
        {!generate.isPending && !markdown && (
          <p className="text-sm text-muted-foreground">
            Generate a blameless postmortem from everything recorded: the incident timeline, each investigator’s run, approvals, status-page posts,
            and any attached war-room call notes from Jamie.
          </p>
        )}
        {!generate.isPending && markdown && (
          <>
            <div className="mb-4 flex justify-end gap-2">
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
              <Button size="sm" variant="outline" onClick={() => download(`${incident.id}-postmortem.md`, markdown)}>
                <Download data-icon="inline-start" /> Download .md
              </Button>
            </div>
            <div className="prose-postmortem mx-auto max-w-3xl">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
            </div>
          </>
        )}
      </article>
    </div>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}
