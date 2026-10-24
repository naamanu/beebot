import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, FileText, Image as ImageIcon, Loader2, Table2 } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentView, OutputFile } from "../../server/types.ts";
import { formatBytesShort } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const isImage = (n: string) => /\.(png|jpe?g|gif|svg)$/i.test(n);
const isMarkdown = (n: string) => /\.md$/i.test(n);
const isCsv = (n: string) => /\.csv$/i.test(n);
const fileUrl = (agentId: string, name: string) => `/api/agents/${agentId}/outputs/${encodeURIComponent(name)}`;

// Deliverables a general agent writes to outputs/. Refreshes while it works.
export function useOutputs(agent: AgentView) {
  return useQuery({
    queryKey: ["outputs", agent.id, agent.status],
    queryFn: async () => {
      const response = await fetch(`/api/agents/${agent.id}/outputs`);
      if (!response.ok) throw new Error(`Could not load outputs (${response.status})`);
      return response.json() as Promise<OutputFile[]>;
    },
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
export function OutputsPanel({ agent, initialFile }: { agent: AgentView; initialFile?: string | null }) {
  const query = useOutputs(agent);
  const files = query.data ?? [];
  const [selected, setSelected] = useState<string | null>(initialFile ?? null);
  const current = files.find((f) => f.name === selected) ?? files.find((f) => isMarkdown(f.name)) ?? files[0] ?? null;

  return (
    <aside className="flex min-h-0 w-[420px] shrink-0 flex-col overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <h3 className="text-base">Outputs</h3>
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">{query.isFetching && <Loader2 className="size-3 animate-spin" aria-label="Refreshing outputs" />}{files.length} file{files.length === 1 ? "" : "s"}</span>
      </div>
      {query.isError && (
        <div role="status" className="border-b border-border p-4 text-sm">
          <p className="font-medium">Couldn’t load the deliverables</p>
          <p className="mt-1 text-muted-foreground">Check your connection and try again.{files.length > 0 && " Previously loaded files are shown below."}</p>
          <Button size="sm" variant="outline" className="mt-3" onClick={() => void query.refetch()}>Try again</Button>
        </div>
      )}
      {query.isLoading ? (
        <div className="space-y-3 p-4" role="status" aria-label="Loading deliverables">
          {["w-3/4", "w-1/2", "w-2/3"].map((width) => <div key={width} className={cn("h-4 animate-pulse rounded bg-secondary", width)} />)}
        </div>
      ) : files.length === 0 ? (
        !query.isError && <div className="p-4 text-sm">
          <p className="font-medium">{agent.status === "working" ? "Waiting for the first deliverable" : "No deliverables were saved"}</p>
          <p className="mt-1 text-muted-foreground">{agent.status === "working" ? "Reports, charts and tables appear here as the agent writes them." : "Review the agent’s activity, or ask it to save its results as files."}</p>
        </div>
      ) : (
        <>
          <ul className="flex max-h-48 shrink-0 flex-col overflow-y-auto border-b border-border py-1" aria-label="Deliverables">
            {files.map((f) => (
              <li key={f.name}>
                <button
                  onClick={() => setSelected(f.name)}
                  aria-current={current?.name === f.name ? "true" : undefined}
                  className={cn("flex w-full items-center gap-2 px-4 py-2 text-left text-[13px] hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring", current?.name === f.name && "bg-secondary")}
                >
                  <FileIcon name={f.name} />
                  <span className="truncate">{f.name}</span>
                  <span className="ml-auto font-mono text-[11px] text-muted-foreground">{formatBytesShort(f.size)}</span>
                </button>
              </li>
            ))}
          </ul>
          {current && <OutputViewer key={current.name} agentId={agent.id} file={current} />}
        </>
      )}
    </aside>
  );
}

function OutputViewer({ agentId, file }: { agentId: string; file: OutputFile }) {
  const url = fileUrl(agentId, file.name);
  const text = useQuery({
    queryKey: ["output", agentId, file.name, file.modifiedAt],
    queryFn: async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Could not load preview (${response.status})`);
      return response.text();
    },
    enabled: isMarkdown(file.name) || isCsv(file.name) || /\.(txt|json)$/i.test(file.name),
  });
  const [imageFailed, setImageFailed] = useState(false);

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
          imageFailed ? <p role="status" className="text-sm text-muted-foreground">This image couldn’t be previewed. Use Open or Download to inspect it.</p> : <img src={`${url}?v=${file.modifiedAt}`} alt={file.name} onError={() => setImageFailed(true)} className="w-full rounded-lg border border-border bg-white" />
        ) : text.isLoading ? (
          <p role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading preview…</p>
        ) : text.isError ? (
          <div role="status" className="py-4 text-sm">
            <p>The file preview couldn’t be loaded.</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void text.refetch()}>Try again</Button>
          </div>
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
