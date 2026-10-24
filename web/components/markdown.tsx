import ReactMarkdown from "react-markdown";
import { cn } from "@/lib/utils";

// Agent messages are Markdown; render them compactly in the app's type scale.
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("space-y-2 text-[13.5px] leading-relaxed [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5", className)}>
      <ReactMarkdown
        components={{
          code: ({ children }) => (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground">{children}</code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-lg border border-border bg-muted p-3 font-mono text-[12px] [&_code]:bg-transparent [&_code]:p-0">
              {children}
            </pre>
          ),
          a: ({ children, href }) => (
            <a href={href} className="underline underline-offset-2" target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
