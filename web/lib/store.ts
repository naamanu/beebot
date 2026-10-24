import { create } from "zustand";
import { toast } from "sonner";
import { invalidateTelemetry } from "./api.ts";
import { buildTasks } from "../../server/tasks.ts";
import { navigate } from "../hooks/use-route.ts";
import type { AgentView, ClientMsg, IncidentView, MicStatus, MissionView, RouteVerdict, ServerMsg, Template, Upload } from "../../server/types.ts";

export interface FeedItem {
  id: number;
  at: number;
  utterance: string;
  verdict?: RouteVerdict;
  question?: string;
}

// What the command bar is composing.
export interface Draft {
  text: string;
  template: Template;
  attachments: (Upload & { uploading?: boolean })[];
  plan: boolean; // plan first, approve, then decide how many agents
}

interface TowerState {
  connected: boolean;
  connectionStatus: "connecting" | "connected" | "reconnecting";
  agents: AgentView[];
  rules: string[];
  incident: IncidentView | null;
  missions: MissionView[];
  selectedTaskId: string | null; // null: the command bar starts a new task
  selectTask: (id: string | null) => void;
  lastSentAt: number; // to auto-select the task an instruction creates
  interim: string;
  micStatus: MicStatus;
  micError: string | null;
  feed: FeedItem[];
  levels: number[]; // recent mic levels, newest last
  steeredAt: Record<string, number>;
  focused: string | null; // agent opened full-screen
  focusedOutput: string | null;
  draft: Draft;
  setDraft: (patch: Partial<Draft>) => void;
  setFocus: (id: string | null, output?: string) => void;
  send: (msg: ClientMsg) => boolean;
  syncCommandContext: () => boolean;
  sendAudio: (pcm: ArrayBuffer) => void;
  pushLevel: (level: number) => void;
  clearLevels: () => void;
}

let socket: WebSocket | null = null;
let nextFeedId = 0;
// Verdicts are broadcast, but opening an inspector belongs to the tab that
// submitted the command (or received its final microphone transcript).
const pendingUtterances = new Set<string>();

function rememberUtterance(text: string): void {
  pendingUtterances.add(text.trim());
  if (pendingUtterances.size > 30) pendingUtterances.delete(pendingUtterances.values().next().value!);
}

export const useTower = create<TowerState>()((set, get) => ({
  connected: false,
  connectionStatus: "connecting",
  agents: [],
  rules: [],
  incident: null,
  missions: [],
  selectedTaskId: null,
  selectTask: (id) => {
    set({ selectedTaskId: id, focused: null, focusedOutput: null });
    get().send({ type: "focus", id: null });
    get().send({ type: "select_task", id });
    get().syncCommandContext();
  },
  lastSentAt: 0,
  interim: "",
  micStatus: "stopped",
  micError: null,
  feed: [],
  levels: [],
  steeredAt: {},
  focused: null,
  focusedOutput: null,
  draft: { text: "", template: "general", attachments: [], plan: true },
  setDraft: (patch) => {
    set({ draft: { ...get().draft, ...patch } });
    get().syncCommandContext();
  },
  setFocus: (id, output) => {
    const { agents, missions, incident, selectedTaskId } = get();
    if (id && !agents.some((agent) => agent.id === id)) return;
    const task = id ? buildTasks(agents, missions, incident).find((task) => task.agentIds.includes(id)) : undefined;
    const taskChanged = task && task.id !== selectedTaskId;
    set({ focused: id, focusedOutput: output ?? null, ...(task ? { selectedTaskId: task.id } : {}) });
    if (taskChanged) get().send({ type: "select_task", id: task.id });
    get().send({ type: "focus", id });
    if (taskChanged) get().syncCommandContext();
  },
  send: (msg) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(msg));
    if (msg.type === "say") rememberUtterance(msg.text);
    if (msg.type === "say" && !msg.taskId) set({ lastSentAt: Date.now() });
    return true;
  },
  syncCommandContext: () => {
    const { draft, selectedTaskId, send } = get();
    return send({
      type: "command_context",
      context: {
        template: draft.template,
        attachments: draft.attachments.filter((file) => !file.uploading).map((file) => file.id),
        plan: draft.plan && draft.template !== "incident",
        taskId: selectedTaskId,
        uploading: draft.attachments.some((file) => file.uploading),
      },
    });
  },
  sendAudio: (pcm) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(pcm);
  },
  pushLevel: (level) => set({ levels: [...get().levels.slice(-31), level] }),
  clearLevels: () => set({ levels: [] }),
}));

function handle(m: ServerMsg): void {
  const set = useTower.setState;
  switch (m.type) {
    case "state":
      set((s) => ({
        agents: m.agents,
        incident: m.incident,
        missions: m.missions,
        selectedTaskId: s.selectedTaskId && m.tasks.some((task) => task.id === s.selectedTaskId) ? s.selectedTaskId : null,
        focused: s.focused && m.agents.some((a) => a.id === s.focused) ? s.focused : null,
        rules: m.rules,
        // On (re)connect the server's history is the source of truth for the feed.
        feed: s.feed.some((f) => !f.verdict)
          ? s.feed
          : // Restored history: at 0, so it never shows as a fresh confirmation.
            m.decisions.map((d) => ({ id: ++nextFeedId, at: 0, utterance: d.verdict.utterance, verdict: d.verdict, question: d.question })),
      }));
      useTower.getState().syncCommandContext();
      break;
    case "agent_event":
      set((s) => ({
        agents: s.agents.map((a) =>
          a.id === m.id ? { ...a, status: m.status, runId: m.runId, costUsd: m.costUsd, events: [...a.events, m.event].slice(-200) } : a,
        ),
        steeredAt: m.event.kind === "steer" ? { ...s.steeredAt, [m.id]: Date.now() } : s.steeredAt,
      }));
      break;
    case "transcript":
      set({ interim: m.final ? "" : m.text });
      if (m.final && m.text.trim()) rememberUtterance(m.text);
      break;
    case "mic_state":
      set({ micStatus: m.status, micError: m.status === "error" ? m.error ?? "Voice connection failed. Try again." : m.status === "connecting" || m.status === "listening" ? null : useTower.getState().micError, ...(m.status === "error" || m.status === "stopped" ? { interim: "", levels: [] } : {}) });
      if (m.status === "error") toast.error(m.error ?? "Voice connection failed. Try again.");
      break;
    case "routing":
      set((s) => ({ feed: [{ id: ++nextFeedId, at: Date.now(), utterance: m.utterance }, ...s.feed].slice(0, 30) }));
      break;
    case "verdict":
      set((s) => {
        const i = s.feed.findIndex((x) => x.utterance === m.verdict.utterance && !x.verdict);
        if (i < 0) {
          return { feed: [{ id: ++nextFeedId, at: Date.now(), utterance: m.verdict.utterance, verdict: m.verdict }, ...s.feed] };
        }
        const feed = [...s.feed];
        feed[i] = { ...feed[i]!, verdict: m.verdict };
        return { feed };
      });
      if (pendingUtterances.delete(m.verdict.utterance.trim()) && m.verdict.action === "applied" && m.verdict.intent !== "rule" && m.verdict.intent !== "incident") {
        const { agents, setFocus } = useTower.getState();
        if (agents.some((agent) => agent.id === m.verdict.target)) {
          setFocus(m.verdict.target);
          navigate("/");
        }
      }
      break;
    case "speak":
      set((s) => ({ feed: s.feed[0] ? [{ ...s.feed[0], question: m.text }, ...s.feed.slice(1)] : s.feed }));
      speak(m.text);
      break;
    case "incident":
      set({ incident: m.incident });
      break;
    case "telemetry":
      invalidateTelemetry();
      break;
    case "notice":
      if (m.level === "error") pendingUtterances.clear();
      if (m.level === "error") toast.error(m.text);
      else toast(m.text);
      break;
  }
}

export function connectTower(): () => void {
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let hasConnected = false;
  let ownedSocket: WebSocket | null = null;
  const abort = new AbortController();
  const retryConnection = () => {
    pendingUtterances.clear();
    useTower.setState({ connected: false, connectionStatus: hasConnected ? "reconnecting" : "connecting", micStatus: "stopped", interim: "", levels: [] });
    if (!closed) retry = setTimeout(() => void open(), 1000);
  };
  const open = async () => {
    try {
      const response = await fetch("/api/session", { method: "POST", headers: { "x-control-tower": "session" }, signal: abort.signal });
      if (!response.ok) throw new Error("Could not establish the control session.");
    } catch {
      if (!closed) retryConnection();
      return;
    }
    if (closed) return;
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ownedSocket = ws;
    ws.onopen = () => {
      hasConnected = true;
      useTower.setState({ connected: true, connectionStatus: "connected" });
      const { focused, selectedTaskId } = useTower.getState();
      if (focused) ws.send(JSON.stringify({ type: "focus", id: focused }));
      if (selectedTaskId) ws.send(JSON.stringify({ type: "select_task", id: selectedTaskId }));
      useTower.getState().syncCommandContext();
    };
    ws.onclose = () => {
      if (!closed) retryConnection();
    };
    ws.onmessage = (e) => handle(JSON.parse(e.data) as ServerMsg);
  };
  void open();
  return () => {
    closed = true;
    pendingUtterances.clear();
    abort.abort();
    clearTimeout(retry);
    ownedSocket?.close();
    if (socket === ownedSocket) socket = null;
  };
}

function speak(text: string): void {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

// Dev-only handle for poking at UI states from the console.
if (import.meta.env?.DEV) (window as unknown as { __tower: typeof useTower }).__tower = useTower;
