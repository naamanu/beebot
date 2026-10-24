import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { Agent, type AgentSnapshot } from "./agents.ts";
import { Reson8Turns } from "./reson8.ts";
import { Router, clarifyingQuestion } from "./router.ts";
import { RuleBook } from "./rules.ts";
import { Telemetry } from "./telemetry.ts";
import type { ClientMsg, Decision, RouteVerdict, RunStatus, ServerMsg } from "./types.ts";
import { DEFAULT_TASKS, addWorktree, createRun, type Run } from "./workspace.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8787);
const AGENT_MODEL = process.env.AGENT_MODEL || "claude-opus-5-5";
const ROUTER_MODEL = process.env.ROUTER_MODEL || "claude-haiku-5-5";
const ROUTER_VOTES = Number(process.env.ROUTER_VOTES || 5);

const SESSION_FILE = join(ROOT, "data", "session.json");
const TEMPLATE = join(ROOT, "demo", "template");

const rules = new RuleBook(join(ROOT, "data", "rules.json"));
const telemetry = new Telemetry(join(ROOT, "data", "telemetry.db"));
telemetry.onChange(() => broadcast({ type: "telemetry" }));
const router = new Router(ROUTER_MODEL, ROUTER_VOTES);
const clients = new Set<WebSocket>();

let run: Run | null = null;
let agents: Agent[] = [];
let recent: string[] = [];
let decisions: Decision[] = []; // newest first, so a reloaded page can rebuild its feed
let pendingClarification: { utterance: string; question: string } | null = null;
let routing = Promise.resolve(); // utterances are routed one at a time, in order

function broadcast(msg: ServerMsg): void {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(data);
}

function state(): ServerMsg {
  return { type: "state", agents: agents.map((a) => a.view()), rules: rules.list(), decisions };
}

// --- Session persistence: the server can restart without losing agents. ---

interface SavedSession {
  run: Run | null;
  agents: AgentSnapshot[];
  decisions: Decision[];
  recent: string[];
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

function save(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 300);
}

function saveNow(): void {
  clearTimeout(saveTimer);
  const data: SavedSession = { run, agents: agents.map((a) => a.snapshot()), decisions, recent: recent.slice(-10) };
  mkdirSync(dirname(SESSION_FILE), { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(data));
}

function makeAgent(id: string, task: string, cwd: string, restore?: AgentSnapshot): Agent {
  return new Agent({
    id,
    task,
    cwd,
    model: AGENT_MODEL,
    restore,
    telemetry,
    workspace: run?.dir ?? "",
    rules: () => rules.asPrompt(),
    onEvent: (agentId, event, status) => {
      const runId = agents.find((a) => a.id === agentId)?.runId ?? null;
      broadcast({ type: "agent_event", id: agentId, event, status, runId });
      save();
    },
  });
}

function restoreSession(): void {
  if (!existsSync(SESSION_FILE)) return;
  try {
    const saved = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as SavedSession;
    if (saved.run && !existsSync(saved.run.repo)) return; // workspace was deleted
    run = saved.run;
    decisions = saved.decisions ?? [];
    recent = saved.recent ?? [];
    agents = saved.agents.filter((a) => existsSync(a.cwd)).map((a) => makeAgent(a.id, a.task, a.cwd, a));
    // Agents that were mid-task when the server stopped carry on by themselves.
    const interrupted = agents.filter((a) => a.status === "working" || a.status === "starting");
    for (const a of interrupted) a.resumeAfterRestart();
    // Runs that were in flight and aren't being resumed are marked interrupted.
    telemetry.closeOrphans(new Set(agents.flatMap((a) => (a.runId ? [a.runId] : []))));
    console.log(`Restored ${agents.length} agent(s) from the last session (${interrupted.length} resumed).`);
  } catch (err) {
    console.warn(`Could not restore the last session: ${(err as Error).message}`);
  }
}

function resetSession(): void {
  for (const a of agents) a.close("reset");
  agents = [];
  run = null;
  recent = [];
  decisions = [];
  pendingClarification = null;
  saveNow();
  broadcast(state());
}

function startSession(tasks: string[]): void {
  resetSession();
  for (const task of tasks) spawnAgent(task, { quiet: true });
  broadcast({ type: "notice", level: "info", text: `Started ${agents.length} agents in ${run!.dir}` });
}

// A new agent in its own worktree. Creates the session workspace on first use,
// so you can start from nothing and assign every task by voice.
function spawnAgent(task: string, { quiet = false } = {}): Agent {
  run ??= createRun(ROOT, TEMPLATE);
  const id = String(agents.reduce((max, a) => Math.max(max, Number(a.id)), 0) + 1);
  const agent = makeAgent(id, task, addWorktree(run, id));
  agents.push(agent);
  agent.begin();
  broadcast(state());
  save();
  if (!quiet) broadcast({ type: "notice", level: "info", text: `Agent ${id} is on it: ${task}` });
  return agent;
}

function hear(utterance: string, focused: string | null): void {
  routing = routing.then(() => routeAndApply(utterance, focused)).catch((err) => {
    broadcast({ type: "notice", level: "error", text: err instanceof Error ? err.message : String(err) });
  });
}

async function routeAndApply(utterance: string, focused: string | null): Promise<void> {
  broadcast({ type: "routing", utterance });
  const verdict = await router.route(utterance, {
    agents: agents.map((a) => a.view()),
    rules: rules.list(),
    recent: recent.slice(-4),
    pendingClarification,
    focused,
  });
  recent.push(utterance);
  telemetry.recordDecision(verdict);

  if (verdict.action === "clarify") {
    const question = clarifyingQuestion(verdict, agents.map((a) => a.view()));
    pendingClarification = { utterance: pendingClarification?.utterance ?? utterance, question };
    remember({ verdict, question });
    broadcast({ type: "verdict", verdict });
    broadcast({ type: "speak", text: question });
    return;
  }

  // An ignored reply doesn't resolve a pending question; anything applied does.
  if (verdict.action === "applied") pendingClarification = null;
  remember({ verdict });
  broadcast({ type: "verdict", verdict });
  if (verdict.action === "applied") await apply(verdict);
}

function remember(d: Decision): void {
  decisions = [d, ...decisions].slice(0, 30);
  save();
}

async function apply(v: RouteVerdict): Promise<void> {
  if (v.intent === "rule") {
    rules.add(v.instruction);
    for (const a of agents) {
      a.traceRouter(v);
      a.addRule(v.instruction);
    }
    broadcast(state());
    return;
  }
  if (v.intent === "assign" && (v.target === "new" || agents.length === 0)) {
    spawnAgent(v.instruction).traceRouter(v);
    return;
  }
  const targets = v.target === "all" ? agents : agents.filter((a) => a.id === v.target);
  for (const a of targets) {
    if (v.intent !== "assign") a.traceRouter(v); // assign opens a fresh run; trace it there
    if (v.intent === "assign") {
      // One task for everyone makes no sense; "all" + assign is treated as a correction.
      if (v.target === "all") a.correct(v.instruction);
      else a.assign(v.instruction);
      a.traceRouter(v);
      continue;
    }
    if (v.intent === "stop") await a.stop(v.instruction || "Stopped by operator");
    else if (v.intent === "correct") a.correct(v.instruction);
    else if (v.intent === "approve") a.approve(v.instruction);
  }
  broadcast(state());
  save();
}

// Words worth biasing the speech model toward.
function phrases(): string[] {
  const numbers = ["one", "two", "three", "four", "five", "six", "seven", "eight"].slice(0, Math.max(agents.length, 4));
  return [...numbers.map((n) => `agent ${n}`), "all agents", "new agent", "new task", "stop", "ship it", "from now on"];
}

const RUN_STATUSES = new Set<RunStatus>(["running", "success", "error", "stopped", "interrupted"]);

// Read-only JSON API for the Runs page.
const http = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/api/summary") return json(200, telemetry.summary());
  if (url.pathname === "/api/runs") {
    const status = url.searchParams.get("status") as RunStatus | null;
    return json(
      200,
      telemetry.listRuns({
        status: status && RUN_STATUSES.has(status) ? status : undefined,
        agent: url.searchParams.get("agent") || undefined,
        q: url.searchParams.get("q") || undefined,
        limit: Math.min(Number(url.searchParams.get("limit")) || 200, 1000),
      }),
    );
  }
  const m = url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
  if (m) {
    const detail = telemetry.getRun(m[1]!);
    return detail ? json(200, detail) : json(404, { error: "run not found" });
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("Control Tower server. Open the web UI at http://localhost:5173\n");
});

const wss = new WebSocketServer({ server: http, path: "/ws" });

wss.on("connection", (ws) => {
  clients.add(ws);
  let mic: Reson8Turns | null = null;
  let focused: string | null = null; // agent this tab has open full-screen
  const send = (m: ServerMsg) => ws.send(JSON.stringify(m));
  send(state());

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      mic?.send(data as Buffer);
      return;
    }
    const msg = JSON.parse(data.toString()) as ClientMsg;
    switch (msg.type) {
      case "start":
        try {
          startSession(msg.tasks.length ? msg.tasks : DEFAULT_TASKS);
        } catch (err) {
          send({ type: "notice", level: "error", text: `Could not start agents: ${(err as Error).message}` });
        }
        break;
      case "say":
        if (msg.text.trim()) hear(msg.text.trim(), focused);
        break;
      case "mic":
        if (msg.on && !mic) {
          const key = process.env.RESON8_API_KEY;
          if (!key) {
            send({ type: "notice", level: "error", text: "RESON8_API_KEY is not set in .env" });
            break;
          }
          mic = new Reson8Turns(key, phrases(), {
            onInterim: (text) => broadcast({ type: "transcript", text, final: false }),
            onTurn: (text) => {
              broadcast({ type: "transcript", text, final: true });
              hear(text, focused);
            },
            onError: (text) => send({ type: "notice", level: "error", text }),
          });
        } else if (!msg.on && mic) {
          mic.close();
          mic = null;
        }
        break;
      case "focus":
        focused = msg.id;
        break;
      case "direct": {
        // Typed straight into an open agent: no routing needed.
        const agent = agents.find((a) => a.id === msg.id);
        if (agent && msg.text.trim()) agent.correct(msg.text.trim());
        break;
      }
      case "control": {
        const agent = agents.find((a) => a.id === msg.id);
        if (agent?.status === "working" && msg.action === "stop") void agent.stop("Stopped by operator");
        if (agent && msg.action === "approve") agent.approve("Looks good");
        break;
      }
      case "reset":
        resetSession();
        break;
      case "clear_rules":
        rules.clear();
        broadcast(state());
        break;
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    mic?.close();
  });
});

restoreSession();

http.listen(PORT, () => {
  console.log(`Control Tower server on :${PORT}  (agents: ${AGENT_MODEL}, router: ${ROUTER_MODEL} × ${ROUTER_VOTES} votes)`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("⚠ ANTHROPIC_API_KEY is not set in .env");
  if (!process.env.RESON8_API_KEY) console.warn("⚠ RESON8_API_KEY is not set in .env (typed input still works)");
});

// Save before exiting so a restart picks up exactly where we left off.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    saveNow();
    for (const a of agents) a.close("shutdown");
    process.exit(0);
  });
}
