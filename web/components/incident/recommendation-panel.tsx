import { CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import type { IncidentView } from "../../../server/types.ts";
import { Button } from "@/components/ui/button";
import { useTower } from "@/lib/store";

export function RecommendationPanel({ incident }: { incident: IncidentView }) {
  const connected = useTower((s) => s.connected);
  const send = useTower((s) => s.send);
  const review = incident.recommendation;
  if (incident.skippedInvestigation) return (
    <section role="status" aria-label="Deferred investigation checks" className="rounded-xl border border-span-http/40 bg-span-http/5 p-4 text-sm">
      <p className="font-medium">Investigation closed with open questions</p>
      <p className="mt-1 text-muted-foreground">{incident.skippedInvestigation.demoRecoveryAt !== undefined ? "Demo services reset to healthy. The open questions are retained in the timeline and postmortem for follow-up." : incident.skippedInvestigation.recoveryConfirmed ? "Recovery was confirmed. The remaining checks are retained for follow-up." : "Recovery is unconfirmed. The skipped checks are retained in the timeline and postmortem."}</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
        {incident.skippedInvestigation.openQuestions.map((question) => <li key={question}>{question}</li>)}
      </ul>
    </section>
  );
  if (!review || review.state === "none" || incident.status === "resolved") return null;
  const decision = review.decision;
  return (
    <section role="status" aria-label="Evidence review" className="rounded-xl border border-span-workflow/30 bg-span-workflow/5 p-4 text-sm">
      {review.state === "reviewing" ? (
        <p className="flex items-center gap-2"><Loader2 className="size-4 animate-spin" /> Reviewing the investigators’ findings…</p>
      ) : review.state === "error" ? (
        <>
          <p className="font-medium">The evidence review failed. No fix was proposed.</p>
          <p className="mt-1 text-muted-foreground">{review.error}</p>
          <Button className="mt-3" variant="outline" size="sm" disabled={!connected} onClick={() => send({ type: "retry_recommendation" })}>
            <RotateCcw /> Retry evidence review
          </Button>
        </>
      ) : decision ? (
        <>
          <p className="font-medium">{decision.action === "rollback" ? `Evidence supports rolling back deploy #${decision.deployId}` : "More investigation needed before a rollback"}</p>
          <p className="mt-1 text-muted-foreground">{decision.reason}</p>
          {decision.findingIds.length > 0 && (
            <ol className="mt-3 space-y-2 border-l-2 border-span-workflow/30 pl-3 text-muted-foreground">
              {decision.findingIds.map((id) => {
                const finding = incident.findings[id - 1];
                return finding ? <li key={id}><span className="font-medium text-foreground">Finding {id} · {finding.role}:</span> {finding.text}</li> : null;
              })}
            </ol>
          )}
          {decision.missingEvidence.length > 0 && (
            <div className="mt-3">
              <p className="font-medium">Next checks</p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
                {decision.missingEvidence.map((item) => <li key={item}>{item}</li>)}
              </ul>
              <p className="mt-3 text-muted-foreground">Tell an investigator what to check next. The tower reviews again when new findings arrive.</p>
              {incident.canSkipInvestigation && <div className="mt-4 flex flex-wrap items-center gap-3">
                <SkipInvestigationButton incidentId={incident.id} />
                <p className="max-w-md text-xs text-muted-foreground">Close the investigation, reset simulated services to healthy and generate the postmortem. Open questions stay documented. The demo reset is recorded separately from agent fixes.</p>
              </div>}
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

export function SkipInvestigationButton({ incidentId }: { incidentId: string }) {
  const connected = useTower((s) => s.connected);
  const send = useTower((s) => s.send);
  return (
    <Button variant="outline" size="sm" disabled={!connected} title="Reset simulated services to healthy and generate a postmortem with open questions preserved" onClick={() => send({ type: "skip_investigation", incidentId })}>
      <CheckCircle2 data-icon="inline-start" /> Skip checks and finish
    </Button>
  );
}
