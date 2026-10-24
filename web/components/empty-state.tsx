import { Code2, Siren, Sparkles } from "lucide-react";
import type { Template } from "../../server/types.ts";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

const KINDS: { template: Template; title: string; icon: React.ComponentType<{ className?: string }>; blurb: string; examples: string[] }[] = [
  {
    template: "general",
    title: "General",
    icon: Sparkles,
    blurb: "Attach a file and ask. Reports, charts and tables come back as outputs.",
    examples: ["Analyze the attached CSV: what changed month over month?", "Summarize this document and list the open questions"],
  },
  {
    template: "coding",
    title: "Code",
    icon: Code2,
    blurb: "Review a plan, then steer its agents together. Each agent has its own git worktree.",
    examples: ["Add due dates to todos, with tests", "Spin someone up to fix search so it ignores case"],
  },
  {
    template: "incident",
    title: "Incident",
    icon: Siren,
    blurb: "Four investigators on a simulated outage, spoken approvals, a postmortem.",
    examples: ["Checkout is failing"],
  },
];

// The empty board: what kinds of work exist, with examples that fill the
// command bar (nothing starts until you press Enter).
export function EmptyState() {
  const setDraft = useTower((s) => s.setDraft);
  const template = useTower((s) => s.draft.template);

  const fill = (t: Template, text: string) => {
    setDraft({ template: t, text });
    document.querySelector<HTMLTextAreaElement>("[data-command-input]")?.focus();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center gap-6 overflow-y-auto px-4 py-6 md:justify-center md:gap-8 md:py-8">
      <div className="text-center">
        <p className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">Your next task</p>
        <h2 className="font-heading text-2xl sm:text-3xl">What should we work on?</h2>
        <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">Describe the outcome you want. Review the plan, steer your agents, and find the results in one place.</p>
      </div>
      <div className="grid w-full max-w-4xl grid-cols-1 gap-3 lg:grid-cols-3">
        {KINDS.map((k) => (
          <section
            key={k.template}
            className={cn(
              "flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10 transition-shadow",
              template === k.template && "ring-2 ring-foreground/25",
            )}
          >
            <div className="flex items-center gap-2">
              <span className="grid size-7 place-items-center rounded-lg bg-secondary">
                <k.icon className="size-4" />
              </span>
              <h3 className="font-heading text-base">{k.title}</h3>
            </div>
            <p className="text-[13px] leading-snug text-muted-foreground">{k.blurb}</p>
            <div className="mt-auto flex flex-col gap-1.5">
              {k.examples.map((e) => (
                <button
                  key={e}
                  onClick={() => fill(k.template, e)}
                  className="rounded-lg border border-border px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                >
                  “{e}”
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
