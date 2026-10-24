import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Loader2, Volume2 } from "lucide-react";
import type { RouteVerdict } from "../../server/types.ts";
import { Dot, Pill } from "@/components/pill";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { INTENT_STYLE, formatDuration, targetLabel } from "@/lib/spans";
import { useTower, type FeedItem } from "@/lib/store";
import { cn } from "@/lib/utils";

export function DecisionFeed() {
  const feed = useTower((s) => s.feed);

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between px-4 pt-4 pb-2">
        <h3 className="text-sm text-muted-foreground">Decisions</h3>
        <span className="font-mono text-[11px] text-muted-foreground">5 votes each</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4 [scrollbar-width:thin]">
        {feed.length === 0 ? (
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            See where instructions were sent and how the router voted. Vote agreement describes consistency, not certainty.
          </p>
        ) : (
          <div className="flex flex-col gap-2.5">
            <AnimatePresence initial={false}>
              {feed.map((item) => (
                <motion.div
                  key={item.id}
                  layout
                  initial={{ opacity: 0, y: -8, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.2 }}
                >
                  <Decision item={item} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </section>
  );
}

const ACTION_STYLE: Record<RouteVerdict["action"], string> = {
  applied: "border-span-tool/40 text-span-tool",
  clarify: "border-span-http/40 text-span-http",
  ignored: "text-muted-foreground",
};

function Decision({ item }: { item: FeedItem }) {
  const v = item.verdict;
  return (
    <div
      className={cn(
        "rounded-xl border border-border bg-card p-3 text-[13px]",
        v?.action === "clarify" && "border-span-http/40",
        v?.action === "ignored" && "opacity-60",
      )}
    >
      <p className="mb-2 leading-snug">“{item.utterance}”</p>

      {!v ? (
        <p className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> voting…
        </p>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2">
            <ArrowRight className="size-3.5 text-muted-foreground" />
            <span className="font-semibold">{targetLabel(v.target)}</span>
            <span className={cn("font-mono text-[11px]", INTENT_STYLE[v.intent].text)}>{v.intent}</span>
            <Pill className={cn("ml-auto h-5 px-2 text-[10px]", ACTION_STYLE[v.action])}>{v.action}</Pill>
          </div>

          {v.instruction && v.action === "applied" && (
            <p className="mb-2.5 line-clamp-3 text-[12.5px] leading-snug text-muted-foreground">{v.instruction}</p>
          )}

          <VoteBar verdict={v} />

          <div className="mt-2 flex items-center gap-1.5">
            <Pill className="h-5 px-2 text-[10px]">{Math.round(v.confidence * 100)}% agree</Pill>
            <Pill className="h-5 px-2 text-[10px]">{formatDuration(v.ms)}</Pill>
          </div>

          {item.question && (
            <p className="mt-2.5 flex items-start gap-2 font-medium text-span-http">
              <Volume2 className="mt-0.5 size-3.5 shrink-0" />
              {item.question}
            </p>
          )}
        </>
      )}
    </div>
  );
}

// One segment per distinct (target, intent) answer, sized by its vote count.
function VoteBar({ verdict }: { verdict: RouteVerdict }) {
  const total = verdict.votes.reduce((s, x) => s + x.count, 0);
  return (
    <div className="flex h-2 gap-[3px]">
      {verdict.votes.map((x, i) => (
        <Tooltip key={i}>
          <TooltipTrigger asChild>
            <motion.span
              className={cn("h-2 rounded-full", INTENT_STYLE[x.intent].bar, i > 0 && "opacity-45")}
              initial={{ flexGrow: 0 }}
              animate={{ flexGrow: x.count }}
              transition={{ duration: 0.35, delay: i * 0.05 }}
              style={{ flexBasis: 0 }}
            />
          </TooltipTrigger>
          <TooltipContent className="font-mono text-xs">
            <span className="flex items-center gap-2">
              <Dot className={INTENT_STYLE[x.intent].dot} />
              {targetLabel(x.target)} · {x.intent} · {x.count}/{total}
            </span>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
