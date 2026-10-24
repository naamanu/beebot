import { create } from "zustand";
import { toast } from "sonner";
import { invalidateTelemetry } from "./api.ts";
import type { AgentView, ClientMsg, IncidentView, RouteVerdict, ServerMsg } from "../../server/types.ts";

export interface FeedItem {
  id: number;
  at: number;
  utterance: string;
  verdict?: RouteVerdict;
  question?: string;
}

interface TowerState {
  connected: boolean;
  agents: AgentView[];
  rules: string[];
  incident: IncidentView | null;
  interim: string;
  feed: FeedItem[];
  levels: number[]; // recent mic levels, newest last
  steeredAt: Record<string, number>;
  focused: string | null; // agent opened full-screen
  setFocus: (id: string | null) => void;
  send: (msg: ClientMsg) => void;
  sendAudio: (pcm: ArrayBuffer) => void;
  pushLevel: (level: number) => void;
  clearLevels: () => void;
}

let socket: WebSocket | null = null;
let nextFeedId = 0;

export const useTower = create<TowerState>()((set, get) => ({
  connected: false,
  agents: [],
  rules: [],
  incident: null,
  interim: "",
  feed: [],
  levels: [],
  steeredAt: {},
  focused: null,
  setFocus: (id) => {
    set({ focused: id });
    get().send({ type: "focus", id });
  },
  send: (msg) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
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
        focused: s.focused && m.agents.some((a) => a.id === s.focused) ? s.focused : null,
        rules: m.rules,
        // On (re)connect the server's history is the source of truth for the feed.
        feed: s.feed.some((f) => !f.verdict)
          ? s.feed
          : m.decisions.map((d) => ({ id: ++nextFeedId, at: Date.now(), utterance: d.verdict.utterance, verdict: d.verdict, question: d.question })),
      }));
      break;
    case "agent_event":
      set((s) => ({
        agents: s.agents.map((a) =>
          a.id === m.id ? { ...a, status: m.status, runId: m.runId, events: [...a.events, m.event].slice(-200) } : a,
        ),
        steeredAt: m.event.kind === "steer" ? { ...s.steeredAt, [m.id]: Date.now() } : s.steeredAt,
      }));
      break;
    case "transcript":
      set({ interim: m.final ? "" : m.text });
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
      if (m.level === "error") toast.error(m.text);
      else toast(m.text);
      break;
  }
}

export function connectTower(): () => void {
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const open = () => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.onopen = () => {
      useTower.setState({ connected: true });
      const { focused } = useTower.getState();
      if (focused) ws.send(JSON.stringify({ type: "focus", id: focused }));
    };
    ws.onclose = () => {
      useTower.setState({ connected: false });
      if (!closed) retry = setTimeout(open, 1000);
    };
    ws.onmessage = (e) => handle(JSON.parse(e.data) as ServerMsg);
  };
  open();
  return () => {
    closed = true;
    clearTimeout(retry);
    socket?.close();
  };
}

function speak(text: string): void {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

// Dev-only handle for poking at UI states from the console.
if (import.meta.env.DEV) (window as unknown as { __tower: typeof useTower }).__tower = useTower;
