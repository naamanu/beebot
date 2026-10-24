import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, FileText, Image as ImageIcon, Table2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentView, OutputFile } from "../../server/types.ts";
import { formatBytesShort } from "@/lib/format";
import { cn } from "@/lib/utils";

const isImage = (n: string) => /\.(png|jpe?g|gif|svg)$/i.test(n);
const isMarkdown = (n: string) => /\.md$/i.test(n);
const isCsv = (n: string) => /\.csv$/i.test(n);
const fileUrl = (agentId: string, name: string) => `/api/agents/${agentId}/outputs/${encodeURIComponent(name)}`;

// Deliverables a general agent writes to outputs/. Refreshes while it works.
export function useOutputs(agent: AgentView) {
  return useQuery({
    queryKey: ["outputs", agent.id],
    queryFn: async () => (await (await fetch(`/api/agents/${agent.id}/outputs`)).json()) as OutputFile[],
    enabled: agent.template === "general",
    refetchInterval: agent.status === "working" ? 3000 : false,
  });
}

// Compact list for agent cards.
export function OutputChips({ agent, onOpen }: { agent: AgentView; onOpen: () => void }) {
  const files = useOutputs(agent).data ?? [];
  if (!files.length) return null;
  return (
    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden">
      <span className="shrink-0 text-[11px] text-muted-foreground">Outputs</span>
      {files.slice(0, 4).map((f) => (
        <button
          key={f.name}
          onClick={onOpen}
          className="inline-flex h-6 min-w-0 shrink items-center gap-1 rounded-md border border-border bg-secondary/60 px-2 text-[11px] hover:bg-secondary"
        >
          <FileIcon name={f.name} />
          <span className="truncate">{f.name}</span>
        </button>
      ))}
      {files.length > 4 && <span className="text-[11px] text-muted-foreground">+{files.length - 4}</span>}
    </div>
  );
}

// Full viewer for the focus view.
export function OutputsPanel({ agent }: { agent: AgentView }) {
  const files = useOutputs(agent).data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const current = files.find((f) => f.name === selected) ?? files.find((f) => isMarkdown(f.name)) ?? files[0] ?? null;

  return (
    <aside className="flex min-h-0 w-[420px] shrink-0 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-base">Outputs</h3>
        <span className="font-mono text-[11px] text-muted-foreground">outputs/ · {files.length} files</span>
      </div>
      {files.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          {agent.status === "working" ? "Reports, charts and tables appear here as the agent writes them." : "No outputs."}
        </p>
      ) : (
        <>
          <ul className="flex shrink-0 flex-col border-b border-border py-1">
            {files.map((f) => (
              <li key={f.name}>
                <button
                  onClick={() => setSelected(f.name)}
                  className={cn("flex w-full items-center gap-2 px-4 py-1.5 text-left text-[13px] hover:bg-accent", current?.name === f.name && "bg-secondary")}
                >
                  <FileIcon name={f.name} />
                  <span className="truncate">{f.name}</span>
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">{formatBytesShort(f.size)}</span>
                </button>
              </li>
            ))}
          </ul>
          {current && <OutputViewer agentId={agent.id} file={current} />}
        </>
      )}
    </aside>
  );
}

function OutputViewer({ agentId, file }: { agentId: string; file: OutputFile }) {
  const url = fileUrl(agentId, file.name);
  const text = useQuery({
    queryKey: ["output", agentId, file.name, file.modifiedAt],
    queryFn: async () => (await fetch(url)).text(),
    enabled: isMarkdown(file.name) || isCsv(file.name) || /\.(txt|json)$/i.test(file.name),
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 py-2 text-xs">
        <span className="truncate font-medium">{file.name}</span>
        <a href={url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <ExternalLink className="size-3.5" /> Open
        </a>
        <a href={url} download={file.name} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
          <Download className="size-3.5" /> Download
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-4 [scrollbar-width:thin]">
        {isImage(file.name) ? (
          <img src={`${url}?v=${file.modifiedAt}`} alt={file.name} className="w-full rounded-lg border border-border bg-white" />
        ) : isMarkdown(file.name) ? (
          <div className="prose-postmortem text-[13.5px]">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text.data ?? ""}</ReactMarkdown>
          </div>
        ) : isCsv(file.name) ? (
          <CsvTable text={text.data ?? ""} />
        ) : text.data !== undefined ? (
          <pre className="font-mono text-[11.5px] whitespace-pre-wrap">{text.data}</pre>
        ) : (
          <p className="text-sm text-muted-foreground">No preview for this file type. Use Open or Download.</p>
        )}
      </div>
    </div>
  );
}

// First 50 rows; enough to see the shape. Handles simple quoted fields.
function CsvTable({ text }: { text: string }) {
  const rows = text
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 51)
    .map((line) => line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')) ?? []);
  if (!rows.length) return null;
  const [head, ...body] = rows;
  return (
    <table className="w-full border-collapse font-mono text-[11.5px]">
      <thead>
        <tr>
          {head!.map((h, i) => (
            <th key={i} className="sticky top-0 border-b border-border bg-card py-1.5 pr-3 text-left font-medium text-muted-foreground">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {body.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} className="border-b border-border py-1 pr-3 whitespace-nowrap">
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FileIcon({ name }: { name: string }) {
  const Icon = isImage(name) ? ImageIcon : isCsv(name) ? Table2 : FileText;
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />;
}
