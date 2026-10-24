import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Dot } from "@/components/pill";
import { useTower } from "@/lib/store";

export function RulesPanel() {
  const rules = useTower((s) => s.rules);
  const send = useTower((s) => s.send);

  return (
    <section className="border-t border-border p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm text-muted-foreground">Standing rules</h3>
        {rules.length > 0 && (
          <Button variant="ghost" size="xs" onClick={() => send({ type: "clear_rules" })}>
            Clear
          </Button>
        )}
      </div>
      {rules.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Say “from now on…” to add one.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          <AnimatePresence initial={false}>
            {rules.map((r) => (
              <motion.li
                key={r}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-start gap-2 text-[13px] leading-snug"
              >
                <Dot className="mt-1.5 bg-span-chat" />
                {r}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}
    </section>
  );
}
