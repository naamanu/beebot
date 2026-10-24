import { Play, RadioTower } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Dot } from "@/components/pill";
import { INTENT_STYLE } from "@/lib/spans";
import { useTower } from "@/lib/store";
import type { Intent } from "../../server/types.ts";

const EXAMPLES: { say: string; intent: Intent }[] = [
  { say: "New agent: add due dates to todos.", intent: "assign" },
  { say: "Spin someone up to fix search.", intent: "assign" },
  { say: "From now on, no new dependencies.", intent: "rule" },
  { say: "Two, stop. Wrong file.", intent: "stop" },
];

export function EmptyState() {
  const send = useTower((s) => s.send);
  const connected = useTower((s) => s.connected);

  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <RadioTower />
        </EmptyMedia>
        <EmptyTitle className="font-heading text-3xl">Talk to your coding agents.</EmptyTitle>
        <EmptyDescription>
          Hold Space and hand out work out loud. Each task gets its own Claude agent, and every instruction is voted on before it lands.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <ul className="flex w-full flex-col gap-2 text-left">
          {EXAMPLES.map((e) => (
            <li key={e.say} className="flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2">
              <Dot className={INTENT_STYLE[e.intent].dot} />
              <span className="text-sm">“{e.say}”</span>
              <span className={`ml-auto font-mono text-[11px] ${INTENT_STYLE[e.intent].text}`}>{e.intent}</span>
            </li>
          ))}
        </ul>
        <Button size="lg" variant="outline" onClick={() => send({ type: "start", tasks: [] })} disabled={!connected}>
          <Play data-icon="inline-start" />
          Or start 4 demo tasks
        </Button>
      </EmptyContent>
    </Empty>
  );
}
