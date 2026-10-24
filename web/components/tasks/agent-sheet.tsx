import { useState } from "react";
import { ArrowUp, Square, Undo2, Waypoints, WrapText } from "lucide-react";
import { toast } from "sonner";
import type { AgentView } from "../../../server/types.ts";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dot, Pill } from "@/components/pill";
import { Timeline } from "@/components/agent-timeline";
import { ApprovalCard } from "@/components/incident/approval-card";
import { OutputsPanel, useOutputs } from "@/components/outputs-panel";
import { useNow } from "@/hooks/use-now";
import { navigate } from "@/hooks/use-route";
import { STATUS_STYLE, agentName, formatDuration } from "@/lib/spans";
import { useTower } from "@/lib/store";
import { cn } from "@/lib/utils";

// The inspector has its own composer so its modal focus boundary contains
// everything needed to review and steer this agent.
export function AgentSheet() {
  const focused = useTower((s) => s.focused);
  const agents = useTower((s) => s.agents);
  const setFocus = useTower((s) => s.setFocus);
  const agent = agents.find((a) => a.id === focused) ?? null;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return (
    <Sheet open={!!agent} onOpenChange={(open) => !open && setFocus(null)}>
      <SheetContent className="gap-0 p-0" style={{ width: "min(48rem, 100vw)", maxWidth: "100vw" }}>
        {agent && (
          <AgentDetail
            key={agent.id}
            agent={agent}
            draft={drafts[agent.id] ?? ""}
            onDraftChange={(text) => setDrafts((previous) => ({ ...previous, [agent.id]: text }))}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function AgentDetail({ agent, draft, onDraftChange }: { agent: AgentView; draft: string; onDraftChange: (text: string) => void }) {
  const send = useTower((s) => s.send);
  const connected = useTower((s) => s.connected);
  const focusedOutput = useTower((s) => s.focusedOutput);
  const live = agent.status === "working" || agent.status === "starting";
  const now = useNow(1000, live);
  const outputs = useOutputs(agent).data ?? [];
  const [tab, setTab] = useState<"activity" | "outputs">(focusedOutput || (outputs.length && !live) ? "outputs" : "activity");
  const first = agent.events[0]?.at;
  const elapsed = first ? (live ? now : (agent.events.at(-1)?.at ?? now)) - first : 0;
  const status = STATUS_STYLE[agent.status];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SheetHeader className="gap-3 border-b border-border p-5 pr-12">
        <div className="flex flex-wrap items-center gap-2">
          <span className="grid size-7 place-items-center rounded-md bg-secondary font-heading text-sm" title={`Say “${agent.id}” to address this agent`}>
            {agent.id}
          </span>
          <SheetTitle className="font-heading text-lg">{agentName(agent)}</SheetTitle>
          <Pill className={status.className}>
            <Dot className={status.dot} />
            {status.label}
          </Pill>
          <Pill>{formatDuration(elapsed)}</Pill>
          <Pill>${agent.costUsd.toFixed(3)}</Pill>
        </div>
        <SheetDescription className="line-clamp-3 break-words text-[13px]">{agent.title ?? agent.task}</SheetDescription>
        <div className="flex flex-wrap items-center gap-2">
          {agent.startsAt && (
            <Button size="sm" variant="outline" disabled={!connected} onClick={() => send({ type: "cancel_start", id: agent.id })}>
              <Undo2 data-icon="inline-start" /> Cancel before it starts
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={!connected || agent.status !== "working"} onClick={() => send({ type: "control", id: agent.id, action: "stop" })}>
            <Square data-icon="inline-start" /> Stop
          </Button>
          {agent.template !== "incident" && (
            <Button
              size="sm"
              variant="outline"
              disabled={!connected || !!agent.startsAt}
              title="Tell it to finish up: make sure tests pass, then commit"
              onClick={() => send({ type: "control", id: agent.id, action: "approve" })}
            >
              <WrapText data-icon="inline-start" /> Wrap up
            </Button>
          )}
          {agent.runId && (
            <Button size="sm" variant="ghost" onClick={() => navigate(`/runs/${agent.runId}`)}>
              <Waypoints data-icon="inline-start" /> Trace
            </Button>
          )}
        </div>
        {agent.approval && <ApprovalCard approval={agent.approval} />}
      </SheetHeader>

      {agent.template === "general" && (
        <div className="flex gap-1 border-b border-border px-5 pt-2">
          {(["activity", "outputs"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm capitalize",
                tab === t ? "border-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t}
              {t === "outputs" && outputs.length > 0 && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{outputs.length}</span>}
            </button>
          ))}
        </div>
      )}
      {tab === "outputs" && agent.template === "general" ? (
        <div className="flex min-h-0 flex-1 p-3 [&>aside]:w-full [&>aside]:ring-0">
          <OutputsPanel agent={agent} initialFile={focusedOutput} />
        </div>
      ) : (
        <Timeline events={agent.events} />
      )}
      <form
        className="shrink-0 border-t border-border bg-card p-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!draft.trim() || agent.startsAt) return;
          if (!send({ type: "direct", id: agent.id, text: draft.trim() })) {
            toast.error("Message not sent. Reconnecting; your draft is saved.");
            return;
          }
          onDraftChange("");
        }}
      >
        <label htmlFor="agent-message" className="mb-2 block text-xs font-medium">Message {agentName(agent)} directly</label>
        <div className="flex items-end gap-2 rounded-xl border border-input bg-background p-2 focus-within:ring-2 focus-within:ring-ring/50">
          <textarea
            id="agent-message"
            data-agent-input
            rows={2}
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Give a correction or ask a follow-up…"
            className="max-h-36 min-h-12 min-w-0 flex-1 resize-y bg-transparent px-1 py-1 text-sm outline-none"
            aria-describedby="agent-message-hint"
          />
          <Button type="submit" size="icon" disabled={!connected || !draft.trim() || !!agent.startsAt} aria-label={`Send to ${agentName(agent)}`}>
            <ArrowUp />
          </Button>
        </div>
        <p id="agent-message-hint" className="mt-2 text-[11px] text-muted-foreground" role="status">
          {!connected ? "Reconnecting. Your draft will stay here." : agent.startsAt ? "Messaging is available once this agent starts." : "Sent only to this agent · Enter to send · Shift+Enter for a new line"}
        </p>
      </form>
    </div>
  );
}
