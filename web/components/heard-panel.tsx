import { useState } from "react";
import { CornerDownLeft } from "lucide-react";
import { motion } from "motion/react";
import { Input } from "@/components/ui/input";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

export function HeardPanel({ micOn }: { micOn: boolean }) {
  const interim = useTower((s) => s.interim);
  const levels = useTower((s) => s.levels);
  const send = useTower((s) => s.send);
  const [typed, setTyped] = useState("");

  const bars = Array.from({ length: 32 }, (_, i) => levels[levels.length - 32 + i] ?? 0);

  return (
    <section className="flex flex-col gap-3 border-b border-border p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm text-muted-foreground">Heard</h3>
        <div className="flex h-5 items-end gap-[2px]" aria-hidden>
          {bars.map((l, i) => (
            <motion.span
              key={i}
              className={cn("w-[3px] rounded-full", micOn ? "bg-span-error" : "bg-muted-foreground/30")}
              animate={{ height: 3 + Math.min(l * 60, 17) }}
              transition={{ duration: 0.1 }}
            />
          ))}
        </div>
      </div>
      <p className={cn("min-h-12 text-[15px] leading-snug", interim ? "text-foreground" : "text-muted-foreground")}>
        {interim || (micOn ? "Listening…" : "Hold Space and talk to your agents.")}
      </p>
      <form
        className="relative"
        onSubmit={(e) => {
          e.preventDefault();
          if (!typed.trim()) return;
          send({ type: "say", text: typed.trim() });
          setTyped("");
        }}
      >
        <Input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="…or type an instruction"
          className="pr-9"
        />
        <CornerDownLeft className="pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
      </form>
    </section>
  );
}
