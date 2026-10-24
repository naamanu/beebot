import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowUp, Code2, FileText, Loader2, Mic, Paperclip, Siren, Sparkles, X } from "lucide-react";
import { toast } from "sonner";
import type { RoutePreview, Template, Upload } from "../../server/types.ts";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBytesShort } from "@/lib/format";
import { shouldPlan, useTower } from "@/lib/store";
import { useSelectedTask } from "@/hooks/use-tasks";
import { agentName, targetLabel } from "@/lib/spans";
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
  const micStatus = useTower((s) => s.micStatus);
  const micError = useTower((s) => s.micError);
  const level = useTower((s) => s.levels.at(-1) ?? 0);
  const connected = useTower((s) => s.connected);
  const incident = useTower((s) => s.incident);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const task = useSelectedTask();
  const selectTask = useTower((s) => s.selectTask);
  const focused = useTower((s) => s.focused);
  const reduceMotion = useReducedMotion();
  const preview = usePreview(draft.text, draft.attachments.map((a) => a.name), micOn, task?.id ?? null, connected);

  // ⌘K / Ctrl+K focuses the bar from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const agentInput = document.querySelector<HTMLTextAreaElement>("[data-agent-input]");
        if (agentInput) agentInput.focus();
        else if (!document.querySelector('[role="dialog"]')) input.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Grow with the text, up to five lines.
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    const resize = () => {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
      if (!el.value) el.scrollTop = 0;
    };
    let width = el.clientWidth;
    let frame = 0;
    resize();
    const observer = new ResizeObserver(() => {
      if (width === el.clientWidth) return;
      width = el.clientWidth;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(resize);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [draft.text, task?.id, micOn]);

  const uploading = draft.attachments.some((a) => a.uploading);
  const canSend = connected && !uploading && (draft.text.trim().length > 0 || draft.attachments.length > 0);

  const submit = () => {
    if (!canSend) return;
    const text = draft.text.trim() || "Analyze the attached files and summarize what matters.";
    const sent = send({
      type: "say",
      text,
      template: draft.template,
      attachments: draft.attachments.map((a) => a.id),
      plan: shouldPlan(draft.plan, text, false) && draft.template !== "incident",
      taskId: task?.id ?? null,
    });
    if (sent) setDraft({ text: "", attachments: [] });
    else toast.error("Instruction not sent. Your draft is saved while reconnecting.");
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
        <Confirmation />
        {micError && <p role="alert" className="px-4 pt-3 text-sm text-span-error">{micError}</p>}
        {draft.attachments.length > 0 && (
          <div className="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto px-3 pt-3">
            {draft.attachments.map((a) => (
              <span key={a.id} className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-lg border border-border bg-secondary/60 pr-1 pl-2 text-xs">
                {a.uploading ? <Loader2 className="size-3.5 animate-spin" /> : <FileText className="size-3.5 text-muted-foreground" />}
                <span className="max-w-32 truncate sm:max-w-48">{a.name}</span>
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
                onClick={onToggleMic}
                disabled={!connected}
                aria-label={micOn ? "Stop listening" : "Talk"}
                className={cn("relative h-10 shrink-0 gap-2 rounded-xl px-4 text-[14px]", micOn && "bg-span-error text-white hover:bg-span-error/90")}
              >
                {micOn && (
                  <motion.span
                    aria-hidden
                    className="absolute inset-0 rounded-xl ring-2 ring-span-error"
                    animate={reduceMotion ? { scale: 1, opacity: 0.5 } : { scale: 1 + Math.min(level * 2, 0.3), opacity: 0.3 + Math.min(level * 3, 0.6) }}
                    transition={{ duration: 0.08 }}
                  />
                )}
                {micOn && micStatus === "connecting" ? <Loader2 className="animate-spin" /> : <Mic />}
                {micOn ? "Listening" : "Talk"}
                {!micOn && <Kbd className="bg-primary-foreground/15 text-primary-foreground">Space</Kbd>}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Click to talk, or hold Space</TooltipContent>
          </Tooltip>

          {micOn ? (
            <p className={cn("min-h-10 flex-1 py-1.5 font-heading text-xl leading-snug", interim ? "text-foreground" : "text-muted-foreground")} aria-live="polite">
              {interim || (micStatus === "listening" ? "Listening… speak to your agents" : "Connecting to speech service…")}
            </p>
          ) : (
            <textarea
              id="task-command"
              aria-label={task ? `Message task: ${task.title}` : "Describe a new task"}
              data-command-input
              ref={input}
              rows={1}
              value={draft.text}
              onChange={(e) => setDraft({ text: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
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
              placeholder={task ? "Message this task…" : placeholder(draft.template, !!incident)}
              className="min-h-9 min-w-0 flex-1 resize-none bg-transparent py-2 text-[15px] leading-snug outline-none placeholder:text-muted-foreground"
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
          {task ? (
            <>
              <span className="text-[11px] text-muted-foreground">To:</span>
              <span className="inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-foreground/20 bg-foreground px-2.5 text-xs text-background sm:max-w-80" title={task.title}>
                <span className="truncate">{focused ? `${agentName(useTower.getState().agents.find((a) => a.id === focused) ?? { id: focused, role: null })} in ` : ""}{task.title}</span>
              </span>
              <button onClick={() => selectTask(null)} className="rounded text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring">
                start a new task instead
              </button>
              <PreviewLine preview={preview} template={draft.template} hasFiles={draft.attachments.length > 0} incidentActive={!!incident} plan={shouldPlan(draft.plan, draft.text, false)} />
            </>
          ) : (
            <>
          <span className="mr-0.5 text-[11px] text-muted-foreground">New task:</span>
          {TEMPLATES.map((t) => (
            <Tooltip key={t.id}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setDraft({ template: t.id })}
                  aria-pressed={draft.template === t.id}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors focus-visible:outline-2 focus-visible:outline-ring",
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
                  onClick={() => setDraft({ plan: ({ auto: "on", on: "off", off: "auto" } as const)[draft.plan] })}
                  className="ml-1 inline-flex h-7 items-center gap-1 rounded-full border border-border px-2.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                  aria-label={`Planning: ${draft.plan}. Click to change.`}
                >
                  Plan: <span className="font-medium text-foreground">{{ auto: "Auto", on: "Always", off: "Never" }[draft.plan]}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-72">
                Auto: typed multi-part requests get a plan to approve first; short requests and anything you say start right away. Always / Never: override.
              </TooltipContent>
            </Tooltip>
          )}
          <PreviewLine preview={preview} template={draft.template} hasFiles={draft.attachments.length > 0} incidentActive={!!incident} plan={shouldPlan(draft.plan, draft.text, false)} />
            </>
          )}
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
function usePreview(text: string, attachments: string[], micOn: boolean, taskId: string | null, connected: boolean) {
  const [preview, setPreview] = useState<{ key: string; value: RoutePreview | "loading" } | null>(null);
  const key = JSON.stringify([text.trim(), attachments, taskId]);
  useEffect(() => {
    if (!connected || micOn || text.trim().length < 4) {
      setPreview(null);
      return;
    }
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setPreview({ key, value: "loading" });
      try {
        const res = await fetch("/api/preview", {
          method: "POST",
          body: JSON.stringify({ text: text.trim(), attachments, taskId }),
          signal: ctrl.signal,
        });
        if (ctrl.signal.aborted) return;
        if (res.ok) {
          const value = (await res.json()) as RoutePreview;
          if (!ctrl.signal.aborted) setPreview({ key, value });
        }
        else setPreview(null);
      } catch {
        if (!ctrl.signal.aborted) setPreview(null);
      }
    }, 650);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, micOn, connected]);
  return connected && !micOn && preview?.key === key ? preview.value : null;
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
  return <span className="min-w-0 basis-full truncate font-mono text-[11px] text-muted-foreground" title="Suggested destination; the final routing decision may differ">Suggested: {describe(preview, template, hasFiles, incidentActive, plan)}</span>;
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
  const a = useTower.getState().agents.find((x) => x.id === p.target);
  const who = p.target === "all" ? "all agents" : a ? agentName(a) : `agent ${p.target}`;
  const verb = { assign: "next task", stop: "stop / deny", correct: "correction", approve: "approve", rule: "rule", incident: "incident", chatter: "" }[p.intent];
  return `${who} · ${verb}`;
}

// What happened to the last instruction, in one line: replaces the old
// decisions column. Shows the question when the router asks back.
function Confirmation() {
  const latest = useTower((s) => s.feed[0]);
  const agents = useTower((s) => s.agents);
  const now = useNowTick(1000);
  if (!latest) return null;
  const v = latest.verdict;
  const recent = v?.action === "clarify" || now - latest.at < 8000;
  if (!recent) return null;
  const who = (t: string) => {
    const a = agents.find((x) => x.id === t);
    return a ? agentName(a) : targetLabel(t);
  };
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-[12.5px] [&>span]:break-words",
        v?.action === "clarify" ? "bg-span-http/10 text-foreground" : "text-muted-foreground",
      )}
      role="status"
    >
      {!v ? (
        <>
          <Loader2 className="size-3.5 animate-spin" /> Working out what “{latest.utterance.slice(0, 60)}” means…
        </>
      ) : v.action === "clarify" ? (
        <span className="font-medium text-span-http">{latest.question ?? "Which agent did you mean?"}</span>
      ) : v.action === "ignored" ? (
        <span>Heard “{latest.utterance.slice(0, 60)}”, not an instruction, so nothing was sent.</span>
      ) : (
        <span>
          <span className="text-foreground">→ {v.intent === "incident" ? "incident" : v.target === "plan" ? "the plan" : v.intent === "assign" && v.target === "new" ? "new task" : who(v.target)}</span> · {v.intent === "incident" ? (v.incidentAction === "declare" ? "declare" : `mark ${v.incidentAction}`) : v.intent}
          {v.instruction ? `: ${v.instruction.slice(0, 90)}${v.instruction.length > 90 ? "…" : ""}` : ""}
        </span>
      )}
      {v && <VoteDots votes={v.votes} />}
    </div>
  );
}

function useNowTick(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

// The decision engine, visible: one block per router vote, filled when it
// agreed with the winning reading.
function VoteDots({ votes }: { votes: { count: number }[] }) {
  const total = votes.reduce((n, v) => n + v.count, 0);
  const agree = votes[0]?.count ?? 0;
  return (
    <span
      className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[11px]"
      title="Each instruction is read by several independent votes; the share that agree decides whether the tower acts or asks back"
    >
      <span className="flex gap-0.5" aria-hidden>
        {Array.from({ length: total }, (_, i) => (
          <span key={i} className={cn("h-2.5 w-1.5 rounded-[2px]", i < agree ? "bg-foreground" : "bg-foreground/20")} />
        ))}
      </span>
      {agree}/{total} agree
    </span>
  );
}
