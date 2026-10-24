import { cn } from "@/lib/utils";

// Rounded mono metric chip, e.g. "8.42s" or "$0.0117".
export function Pill({ className, children, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-secondary/60 px-2.5 font-mono text-[11px] tabular-nums text-secondary-foreground",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export function Dot({ className }: { className?: string }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-[3px]", className)} />;
}
