import { Lightbulb, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTower } from "@/lib/store";

// Work the tower suggested on its own, e.g. action items from a review call.
// It only offers; nothing starts until the commander says so.
export function ProposalBanner() {
  const proposals = useTower((s) => s.proposals);
  const send = useTower((s) => s.send);
  const connected = useTower((s) => s.connected);
  const p = proposals[0];
  if (!p) return null;
  return (
    <section className="flex shrink-0 items-start gap-3 rounded-xl border border-span-workflow/30 bg-span-workflow/5 px-4 py-3" aria-label="Suggested follow-ups">
      <Lightbulb className="mt-0.5 size-4 shrink-0 text-span-workflow" />
      <div className="min-w-0 flex-1">
        <p className="text-[13.5px] font-medium">{p.title}</p>
        <ul className="mt-1 list-disc pl-4 text-[13px] text-muted-foreground">
          {p.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="mt-1.5 text-xs text-muted-foreground">Suggested by the tower{p.source === "jamie" ? " from Jamie's call notes" : ""}. Or say “start the follow-ups”.</p>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button size="sm" disabled={!connected} onClick={() => send({ type: "accept_proposal", id: p.id })}>
          <Play data-icon="inline-start" /> Start {p.items.length} task{p.items.length === 1 ? "" : "s"}
        </Button>
        <Button size="sm" variant="ghost" disabled={!connected} onClick={() => send({ type: "dismiss_proposal", id: p.id })} aria-label="Dismiss">
          <X />
        </Button>
      </div>
    </section>
  );
}
