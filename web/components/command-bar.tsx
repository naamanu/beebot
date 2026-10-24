import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { ArrowUp, Code2, FileText, Loader2, Mic, Paperclip, Siren, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import type { RoutePreview, Template, Upload } from "../../server/types.ts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBytesShort } from "@/lib/format";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

const TEMPLATES: { id: Template; label: string; icon: React.ComponentType<{ className?: string }>; hint: string }[] = [
  { id: "general", label: "General", icon: Sparkles, hint: "Analysis, research, writing. Attach files; results land in outputs." },
  { id: "coding", label: "Code", icon: Code2, hint: "Changes to a repository, in its own git worktree." },
  { id: "incident", label: "Incident", icon: Siren, hint: "Declare an incident: four investigators, spoken approvals, a postmortem." },
];

export async function uploadFile(file: File): Promise<Upload> {
  const res = await fetch(`/api/uploads?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
  if (!res.ok) throw new Error((await res.json()).error ?? `Upload failed (${res.status})`);
  return res.json() as Promise<Upload>;
}

// The one place to start or steer work. Type, or hold Space to talk into it.
export function CommandBar({ micOn, onToggleMic }: { micOn: boolean; onToggleMic: () => void }) {
  const draft = useTower((s) => s.draft);
  const setDraft = useTower((s) => s.setDraft);
  const send = useTower((s) => s.send);
  const interim = useTower((s) => s.interim);
  const level = useTower((s) => s.levels.at(-1) ?? 0);
  const connected = useTower((s) => s.connected);
  const incident = useTower((s) => s.incident);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const preview = usePreview(draft.text, draft.attachments.map((a) => a.name), micOn);

  // ⌘K / Ctrl+K focuses the bar from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Grow with the text, up to five lines.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [draft.text]);

  const uploading = draft.attachments.some((a) => a.uploading);
  const canSend = connected && !uploading && (draft.text.trim().length > 0 || draft.attachments.length > 0);

  const submit = () => {
    if (!canSend) return;
    const text = draft.text.trim() || "Analyze the attached files and summarize what matters.";
    send({ type: "say", text, template: draft.template, attachments: draft.attachments.map((a) => a.id), plan: draft.plan && draft.template !== "incident" });
    setDraft({ text: "", attachments: [] });
  };

  const addFiles = (files: FileList | File[]) => attachFiles(files, setDraft);

  return (
    <div className="shrink-0">
      <div
        className={cn(
          "rounded-2xl bg-card shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_-12px_rgba(0,0,0,0.12)] ring-1 ring-foreground/10 transition-shadow focus-within:ring-foreground/25",
          micOn && "ring-2 ring-span-error/60",
        )}
      >
        {draft.attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3">
            {draft.attachments.map((a) => (
              <span key={a.id} className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-secondary/60 pr-1 pl-2 text-xs">
                {a.uploading ? <Loader2 className="size-3.5 animate-spin" /> : <FileText className="size-3.5 text-muted-foreground" />}
                <span className="max-w-48 truncate">{a.name}</span>
                <span className="font-mono text-[10.5px] text-muted-foreground">{formatBytesShort(a.size)}</span>
                <button
                  className="grid size-5 place-items-center rounded hover:bg-accent"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setDraft({ attachments: draft.attachments.filter((x) => x.id !== a.id) })}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 p-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={micOn ? "default" : "ghost"}
                size="icon"
                onClick={onToggleMic}
                disabled={!connected}
                aria-label={micOn ? "Stop listening" : "Talk"}
                className={cn("relative shrink-0 rounded-xl", micOn && "bg-span-error text-white hover:bg-span-error/90")}
              >
                {micOn && (
                  <motion.span
                    aria-hidden
                    className="absolute inset-0 rounded-xl ring-2 ring-span-error"
                    animate={{ scale: 1 + Math.min(level * 2, 0.3), opacity: 0.3 + Math.min(level * 3, 0.6) }}
                    transition={{ duration: 0.08 }}
                  />
                )}
                <Mic />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Click to talk, or hold Space</TooltipContent>
          </Tooltip>

          {micOn ? (
            <p className={cn("min-h-9 flex-1 py-2 text-[15px] leading-snug", interim ? "text-foreground" : "text-muted-foreground")}>
              {interim || "Listening… speak to your agents"}
            </p>
          ) : (
            <textarea
              ref={input}
              rows={1}
              value={draft.text}
              onChange={(e) => setDraft({ text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
                if (e.key === "Escape") input.current?.blur();
              }}
              onPaste={(e) => {
                if (e.clipboardData.files.length) {
                  e.preventDefault();
                  addFiles(e.clipboardData.files);
                }
              }}
              placeholder={placeholder(draft.template, !!incident)}
              className="min-h-9 flex-1 resize-none bg-transparent py-2 text-[15px] leading-snug outline-none placeholder:text-muted-foreground"
            />
          )}

          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="shrink-0 rounded-xl" onClick={() => fileInput.current?.click()} aria-label="Attach files">
                <Paperclip />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Attach files (or drop / paste them)</TooltipContent>
          </Tooltip>
          <Button size="icon" className="shrink-0 rounded-xl" onClick={submit} disabled={!canSend} aria-label="Send">
            <ArrowUp />
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-3 py-2">
          <span className="mr-0.5 text-[11px] text-muted-foreground">New work:</span>
          {TEMPLATES.map((t) => (
            <Tooltip key={t.id}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setDraft({ template: t.id })}
                  aria-pressed={draft.template === t.id}
                  className={cn(
                    "inline-flex h-6 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
                    draft.template === t.id
                      ? "border-foreground/20 bg-foreground text-background"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  <t.icon className="size-3" />
                  {t.label}
                  {t.id === "coding" && draft.template === "coding" && <span className="opacity-60">· taskboard</span>}
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">{t.hint}</TooltipContent>
            </Tooltip>
          ))}
          {draft.template !== "incident" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  role="switch"
                  aria-checked={draft.plan}
                  onClick={() => setDraft({ plan: !draft.plan })}
                  className="ml-1 inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2 text-xs text-muted-foreground hover:text-foreground"
                >
                  <span className={cn("relative h-3.5 w-6 rounded-full transition-colors", draft.plan ? "bg-foreground" : "bg-foreground/20")}>
                    <span className={cn("absolute top-0.5 size-2.5 rounded-full bg-background transition-all", draft.plan ? "left-3" : "left-0.5")} />
                  </span>
                  Plan first
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                On: new work is analysed and outlined as steps for you to approve; then the planner decides how many agents to use. Off: one agent starts right away.
              </TooltipContent>
            </Tooltip>
          )}
          <PreviewLine preview={preview} template={draft.template} hasFiles={draft.attachments.length > 0} incidentActive={!!incident} plan={draft.plan} />
          <span className="ml-auto hidden items-center gap-1 text-[11px] text-muted-foreground md:flex">
            <Kbd>Space</Kbd> talk · <Kbd>⌘K</Kbd> focus · <Kbd>⏎</Kbd> send
          </span>
        </div>
      </div>
    </div>
  );
}

export function attachFiles(files: FileList | File[], setDraft: (p: Partial<import("@/lib/store").Draft>) => void) {
  for (const file of Array.from(files)) {
    const tempId = `uploading-${crypto.randomUUID()}`;
    const current = () => useTower.getState().draft;
    setDraft({ attachments: [...current().attachments, { id: tempId, name: file.name, size: file.size, uploading: true }] });
    uploadFile(file)
      .then((up) => setDraft({ attachments: current().attachments.map((a) => (a.id === tempId ? up : a)) }))
      .catch((err: Error) => {
        setDraft({ attachments: current().attachments.filter((a) => a.id !== tempId) });
        toast.error(`${file.name}: ${err.message}`);
      });
  }
}

function placeholder(template: Template, incidentActive: boolean): string {
  if (template === "incident" && !incidentActive) return "What's broken? e.g. “Checkout is failing”";
  if (template === "coding") return "Describe a change, or steer an agent: “two, stop”";
  return "Tell your agents what to do, or attach a file to analyze…";
}

// One cheap router vote after you pause typing: where will this go?
function usePreview(text: string, attachments: string[], micOn: boolean) {
  const [preview, setPreview] = useState<RoutePreview | "loading" | null>(null);
  const key = `${text.trim()}|${attachments.join(",")}`;
  useEffect(() => {
    if (micOn || text.trim().length < 4) {
      setPreview(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setPreview("loading");
      try {
        const res = await fetch("/api/preview", {
          method: "POST",
          body: JSON.stringify({ text: text.trim(), attachments }),
          signal: ctrl.signal,
        });
        if (res.ok) setPreview((await res.json()) as RoutePreview);
        else setPreview(null);
      } catch {
        // superseded by newer text
      }
    }, 650);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, micOn]);
  return preview;
}

function PreviewLine({
  preview,
  template,
  hasFiles,
  incidentActive,
  plan,
}: {
  preview: RoutePreview | "loading" | null;
  template: Template;
  hasFiles: boolean;
  incidentActive: boolean;
  plan: boolean;
}) {
  if (!preview) return null;
  if (preview === "loading") return <span className="ml-2 font-mono text-[11px] text-muted-foreground">→ …</span>;
  return <span className="ml-2 truncate font-mono text-[11px] text-foreground/80">→ {describe(preview, template, hasFiles, incidentActive, plan)}</span>;
}

function describe(p: RoutePreview, template: Template, hasFiles: boolean, incidentActive: boolean, plan: boolean): string {
  if (p.target === "plan") return p.intent === "approve" ? "approve the plan" : p.intent === "stop" ? "cancel the plan" : "revise the plan";
  if (p.target === "unclear") return "unclear: will ask which agent";
  if (p.intent === "chatter" || p.target === "none") return "not for an agent: will be ignored";
  if (p.intent === "incident") return p.incidentAction === "declare" ? "declare an incident" : `mark incident ${p.incidentAction}`;
  if (p.intent === "rule") return "standing rule for all agents";
  if (p.intent === "assign" && p.target === "new") {
    if (template === "incident" && !incidentActive) return "declare an incident";
    const kind = template === "general" || hasFiles ? "General" : "Code";
    if (plan) return `plan a ${kind} task${hasFiles ? " on the attached files" : ""}, then decide how many agents`;
    return `new ${kind} agent${hasFiles ? " with the attached files" : ""}`;
  }
  const who = p.target === "all" ? "all agents" : `agent ${p.target}`;
  const verb = { assign: "next task", stop: "stop / deny", correct: "correction", approve: "approve", rule: "rule", incident: "incident", chatter: "" }[p.intent];
  return `${who} · ${verb}`;
}
