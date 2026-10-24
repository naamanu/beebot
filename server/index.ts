import "dotenv/config";
import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { Agent, type AgentSnapshot } from "./agents.ts";
import { INCIDENT_ROLES, Incident } from "./incident/incident.ts";
import { Jamie, type JamieMeeting } from "./incident/jamie.ts";
import { writePostmortem } from "./incident/postmortem.ts";
import { Mission, type SpawnRequest } from "./missions/mission.ts";
import { Reson8Turns } from "./reson8.ts";
import { Router, clarifyingQuestion } from "./router.ts";
import { RuleBook } from "./rules.ts";
import { Telemetry } from "./telemetry.ts";
import type { Approval, ClientMsg, Decision, IncidentStatus, MissionView, OutputFile, RouteVerdict, RunStatus, ServerMsg, Template, Upload } from "./types.ts";
import { DEFAULT_TASKS, addScratchDir, addWorktree, createRun, repoFiles, type Run } from "./workspace.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8787);
const AGENT_MODEL = process.env.AGENT_MODEL || "claude-opus-5-5";
const ROUTER_MODEL = process.env.ROUTER_MODEL || "claude-haiku-5-5";
const ROUTER_VOTES = Number(process.env.ROUTER_VOTES || 5);

const SESSION_FILE = join(ROOT, "data", "session.json");
const UPLOADS = join(ROOT, "data", "uploads");
const UNDO_MS = 4000; // a new agent can be cancelled for this long before it starts
const MAX_UPLOAD = 50 * 1024 * 1024;
const TEMPLATE = join(ROOT, "demo", "template");

const rules = new RuleBook(join(ROOT, "data", "rules.json"));
const telemetry = new Telemetry(join(ROOT, "data", "telemetry.db"));
telemetry.onChange(() => broadcast({ type: "telemetry" }));
const router = new Router(ROUTER_MODEL, ROUTER_VOTES);
const jamie = new Jamie(process.env.JAMIE_API_KEY);
const clients = new Set<WebSocket>();

let run: Run | null = null;
let agents: Agent[] = [];
let recent: string[] = [];
let decisions: Decision[] = []; // newest first, so a reloaded page can rebuild its feed
let pendingClarification: { utterance: string; question: string } | null = null;
let routing = Promise.resolve(); // utterances are routed one at a time, in order
// The active incident lives in memory: the simulated outage isn't persisted.
let incident: Incident | null = null;
let callNotes: JamieMeeting | null = null; // the war-room call, from Jamie
let incidentTimer: ReturnType<typeof setInterval> | undefined;
// Planned tasks. Live missions run here; after a restart, earlier ones come
// back read-only (their agents are restored, the orchestration is not).
let missions: Mission[] = [];
let archivedMissions: MissionView[] = [];

function broadcast(msg: ServerMsg): void {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(data);
}

function missionViews(): MissionView[] {
  return [...missions.map((m) => m.view()), ...archivedMissions].slice(0, 10);
}

function state(): ServerMsg {
  return { type: "state", agents: agents.map((a) => a.view()), rules: rules.list(), decisions, incident: incident?.view() ?? null, missions: missionViews() };
}

// --- Session persistence: the server can restart without losing agents. ---

interface SavedSession {
  missions?: MissionView[];
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
  const data: SavedSession = { run, agents: agents.map((a) => a.snapshot()), decisions, recent: recent.slice(-10), missions: missionViews() };
  mkdirSync(dirname(SESSION_FILE), { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify(data));
}

function makeAgent(
  id: string,
  task: string,
  cwd: string,
  restore?: AgentSnapshot,
  role?: string,
  template?: Template,
  mission?: { id: string; role: string; title?: string },
): Agent {
  const t = template ?? restore?.template;
  return new Agent({
    mission,
    template: t === "general" ? "general" : "coding",
    incident: incident && role && !mission ? { incident, role } : undefined,
    onApproval: (agent, approval) => onApproval(agent, approval),
    id,
    task,
    cwd,
    model: AGENT_MODEL,
    restore,
    telemetry,
    workspace: run?.dir ?? "",
    rules: () => rules.asPrompt(),
    onEvent: (agentId, event, status) => {
      const agent = agents.find((a) => a.id === agentId);
      broadcast({ type: "agent_event", id: agentId, event, status, runId: agent?.runId ?? null, costUsd: agent?.costUsd ?? 0 });
      // A mission's agent finished: let the mission start what comes next.
      const missionId = agent?.view().missionId;
      if (missionId && (event.kind === "result" || (event.kind === "error" && status !== "working"))) {
        missions.find((m) => m.id === missionId)?.onAgentFinished(agentId, event.kind === "result");
      }
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
    // Incident agents can't come back: their simulated production is gone.
    agents = saved.agents
      .filter((a) => existsSync(a.cwd) && a.template !== "incident")
      .map((a) => makeAgent(a.id, a.task, a.cwd, a, a.mission?.role, undefined, a.mission));
    // Missions that were mid-flight can't resume their orchestration.
    archivedMissions = (saved.missions ?? []).map((m) =>
      /done|cancelled|failed/.test(m.status) ? m : { ...m, status: "failed", error: "The server restarted before this task finished." },
    );
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
  missions = [];
  archivedMissions = [];
  endIncident();
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

interface AttachedFile extends Upload {
  path: string;
}

function resolveUploads(ids: string[] = []): AttachedFile[] {
  return ids.flatMap((id) => {
    if (!/^[\w-]+$/.test(id)) return [];
    const dir = join(UPLOADS, id);
    if (!existsSync(dir)) return [];
    const name = readdirSync(dir)[0];
    if (!name) return [];
    return [{ id, name, size: statSync(join(dir, name)).size, path: join(dir, name) }];
  });
}

// Copy attachments into an agent's workspace and describe them for its prompt.
function attach(files: AttachedFile[], cwd: string, folder: string): string {
  if (!files.length) return "";
  mkdirSync(join(cwd, folder), { recursive: true });
  for (const f of files) copyFileSync(f.path, join(cwd, folder, f.name));
  return `\n\nAttached files:\n${files.map((f) => `- ${folder}/${f.name} (${formatBytes(f.size)})`).join("\n")}`;
}

function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
}

// A new agent. Creates the session workspace on first use, so you can start
// from nothing. Coding agents get a git worktree; general agents a folder
// with inputs/ and outputs/. With undo, it waits UNDO_MS before starting.
function spawnAgent(
  task: string,
  {
    quiet = false,
    template = "coding" as Exclude<Template, "incident">,
    files = [] as AttachedFile[],
    undo = false,
    mission = undefined as { id: string; role: string; title?: string } | undefined,
    inputsFrom = [] as SpawnRequest["inputsFrom"],
    baseAgentId = null as string | null,
  } = {},
): Agent {
  run ??= createRun(ROOT, TEMPLATE);
  const id = String(agents.reduce((max, a) => Math.max(max, Number(a.id)), 0) + 1);
  const cwd = template === "general" ? addScratchDir(run, id) : addWorktree(run, id, baseAgentId);
  if (template === "general") mkdirSync(join(cwd, "outputs"), { recursive: true });
  // Another agent's outputs, for work that builds on it.
  for (const from of inputsFrom) {
    const src = agents.find((a) => a.id === from.agentId);
    if (src && existsSync(join(src.cwd, "outputs"))) cpSync(join(src.cwd, "outputs"), join(cwd, "inputs", from.as), { recursive: true });
  }
  const fullTask = task + attach(files, cwd, template === "general" ? "inputs" : "attachments");
  const agent = makeAgent(id, fullTask, cwd, undefined, mission?.role, template, mission);
  agents.push(agent);
  if (undo) {
    agent.beginAfter(UNDO_MS, () => {
      broadcast(state());
      save();
    });
  } else agent.begin();
  broadcast(state());
  save();
  if (!quiet) broadcast({ type: "notice", level: "info", text: `Agent ${id} ${undo ? "starts in a moment" : "is on it"}: ${task}` });
  return agent;
}

// --- Missions: plan first, approve, then decide how many agents ---

function readHead(path: string): string | null {
  if (!/\.(csv|tsv|txt|md|json|jsonl|log|yaml|yml|xml|html|py|js|ts|sql)$/i.test(path)) return null;
  const all = readFileSync(path, "utf8");
  const lines = all.split("\n").filter((l) => l.length);
  const head = lines.slice(0, 20).join("\n").slice(0, 2500);
  return lines.length > 20 ? `[first 20 of ${lines.length} lines]\n${head}` : head;
}

function createMission(request: string, template: "general" | "coding", files: AttachedFile[]): Mission {
  const mission = new Mission(
    {
      template,
      request,
      files: files.map((f) => ({ name: f.name, size: f.size, head: readHead(f.path) })),
      repoFiles: template === "coding" ? repoFiles(TEMPLATE) : [],
    },
    {
      spawn: (m, req) =>
        spawnAgent(req.task, {
          quiet: true,
          template: m.template,
          files,
          mission: { id: m.id, role: req.role, title: req.title },
          inputsFrom: req.inputsFrom,
          baseAgentId: req.baseAgentId,
        }).id,
      changed: () => {
        broadcast(state());
        save();
      },
      speak: (text) => broadcast({ type: "speak", text }),
    },
  );
  missions = [mission, ...missions].slice(0, 10);
  save();
  void mission.start();
  return mission;
}

function decidePlan(missionId: string | null, decision: "approve" | "revise" | "cancel", note = ""): void {
  const mission = missionId ? missions.find((m) => m.id === missionId) : missions.find((m) => m.status === "awaiting_approval");
  if (!mission) return;
  if (decision === "approve") void mission.approve();
  else if (decision === "revise") void mission.revise(note);
  else {
    mission.cancel();
    // Cancelling a running mission stops its agents too.
    for (const a of agents) if (a.view().missionId === mission.id && a.status === "working") void a.stop("Task cancelled");
  }
}

function cancelStart(id: string): void {
  const agent = agents.find((a) => a.id === id);
  if (!agent?.cancelStart()) return;
  agent.close("reset");
  agents = agents.filter((a) => a !== agent);
  broadcast(state());
  broadcast({ type: "notice", level: "info", text: `Cancelled agent ${id} before it started.` });
  save();
}

// --- Incidents ---

function declareIncident(title: string): void {
  resetSession();
  incident = new Incident(title, "SEV1", jamie, () => broadcastIncident());
  callNotes = null;
  run = createRun(ROOT, TEMPLATE);
  for (const role of INCIDENT_ROLES) {
    const id = String(agents.length + 1);
    const agent = makeAgent(id, `${role.task} Incident: ${title}.`, addScratchDir(run, id), undefined, role.name);
    agents.push(agent);
    agent.begin();
  }
  // Metrics move continuously; push them to the UI while the incident is open.
  incidentTimer = setInterval(broadcastIncident, 2000);
  broadcast(state());
  broadcast({ type: "speak", text: `Incident declared: ${title}. Four investigators are on it.` });
  save();
}

function setIncidentStatus(status: IncidentStatus, by: string): void {
  if (!incident) return;
  incident.setStatus(status, by);
  if (status === "resolved") clearInterval(incidentTimer);
  broadcastIncident();
}

function endIncident(): void {
  clearInterval(incidentTimer);
  incident = null;
  callNotes = null;
}

let incidentBroadcastPending = false;
function broadcastIncident(): void {
  if (incidentBroadcastPending) return;
  incidentBroadcastPending = true;
  setImmediate(() => {
    incidentBroadcastPending = false;
    broadcast({ type: "incident", incident: incident?.view() ?? null });
  });
}

// A risky action is waiting (approval set) or was decided (approval null).
function onApproval(agent: Agent, approval: Approval | null): void {
  if (approval) {
    incident?.log("approval", `Requested: ${approval.summary}`, agentLabel(agent));
    // Keep the spoken prompt short: the full text is on screen.
    const spoken = approval.tool === "post_status_update" ? "post a status page update" : approval.summary.toLowerCase();
    const who = agent.view().role ? `${agent.view().role}, agent ${agent.id},` : `Agent ${agent.id}`;
    broadcast({ type: "speak", text: `${who} wants to ${spoken}. Approve?` });
  }
  broadcast(state());
}

function decideApproval(agent: Agent, decision: "approve" | "deny", by: string, note?: string): void {
  const approval = agent.decide(decision, by, note);
  if (approval) incident?.log("approval", `${decision === "approve" ? "Approved" : "Denied"}: ${approval.summary}`, by);
}

function agentLabel(a: Agent): string {
  const role = a.view().role;
  return role ? `${role} (agent ${a.id})` : `agent ${a.id}`;
}

interface HearOptions {
  template?: Template;
  files?: AttachedFile[];
  plan?: boolean; // plan first, then decide how many agents
}

function hear(utterance: string, focused: string | null, opts: HearOptions = {}): void {
  routing = routing.then(() => routeAndApply(utterance, focused, opts)).catch((err) => {
    broadcast({ type: "notice", level: "error", text: err instanceof Error ? err.message : String(err) });
  });
}

async function routeAndApply(utterance: string, focused: string | null, opts: HearOptions): Promise<void> {
  broadcast({ type: "routing", utterance });
  const verdict = await router.route(utterance, {
    agents: agents.map((a) => a.view()),
    rules: rules.list(),
    recent: recent.slice(-4),
    pendingClarification,
    focused,
    incident: incident?.view() ?? null,
    attachments: opts.files?.map((f) => f.name),
    pendingPlan: missions.find((m) => m.status === "awaiting_approval")?.view() ?? null,
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
  if (verdict.action === "applied") await apply(verdict, opts);
}

function remember(d: Decision): void {
  decisions = [d, ...decisions].slice(0, 30);
  save();
}

async function apply(v: RouteVerdict, opts: HearOptions = {}): Promise<void> {
  if (v.intent === "incident") {
    if (v.incidentAction === "declare") declareIncident(v.instruction || "Production incident");
    else if (v.incidentAction !== "none") setIncidentStatus(v.incidentAction, "commander (voice)");
    return;
  }
  // A plan is waiting for approval and this answers it.
  if (v.target === "plan") {
    if (v.intent === "approve") decidePlan(null, "approve");
    else if (v.intent === "stop") decidePlan(null, "cancel");
    else decidePlan(null, "revise", v.instruction || v.utterance);
    return;
  }
  incident?.log("instruction", `“${v.utterance}” → ${v.intent} ${v.target === "all" ? "all agents" : `agent ${v.target}`}`, "commander");
  // Yes or no to an agent that is waiting for approval.
  const waiting = agents.filter((a) => a.approval && (v.target === a.id || v.target === "all"));
  if ((v.intent === "approve" || v.intent === "stop") && waiting.length) {
    for (const a of waiting) {
      a.traceRouter(v);
      decideApproval(a, v.intent === "approve" ? "approve" : "deny", "commander (voice)", v.intent === "stop" ? v.instruction : undefined);
    }
    broadcast(state());
    return;
  }
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
    // With the Incident chip selected and no incident yet, new work starts one.
    if (opts.template === "incident" && !incident) {
      declareIncident(v.instruction);
      return;
    }
    const template = opts.template === "general" || opts.files?.length ? "general" : "coding";
    if (opts.plan) {
      createMission(v.instruction, template, opts.files ?? []);
      return;
    }
    spawnAgent(v.instruction, { template, files: opts.files, undo: true }).traceRouter(v);
    return;
  }
  // Files attached to an instruction for an existing agent go into its workspace.
  if (opts.files?.length && v.target !== "all") {
    const target = agents.find((a) => a.id === v.target);
    if (target) v = { ...v, instruction: v.instruction + attach(opts.files, target.cwd, target.template === "general" ? "inputs" : "attachments") };
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
  return [
    ...numbers.map((n) => `agent ${n}`),
    "all agents",
    "new agent",
    "new task",
    "stop",
    "ship it",
    "from now on",
    "declare an incident",
    "roll back",
    "approve",
    "mitigated",
    "resolved",
  ];
}

const RUN_STATUSES = new Set<RunStatus>(["running", "success", "error", "stopped", "interrupted"]);

// Read-only JSON API for the Runs page.
const http = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const fail = (err: unknown) => json(500, { error: err instanceof Error ? err.message : String(err) });
  if (url.pathname === "/api/uploads" || url.pathname === "/api/preview" || url.pathname.startsWith("/api/agents/")) {
    void workApi(req, res, url, json).catch(fail);
    return;
  }
  if (url.pathname.startsWith("/api/incident") || url.pathname.startsWith("/api/jamie") || url.pathname.startsWith("/webhooks/")) {
    void incidentApi(req, url, json).catch(fail);
    return;
  }
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
        if (msg.text.trim()) hear(msg.text.trim(), focused, { template: msg.template, files: resolveUploads(msg.attachments), plan: msg.plan });
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
      case "plan_decision":
        decidePlan(msg.missionId, msg.decision, msg.note);
        break;
      case "cancel_start":
        cancelStart(msg.id);
        break;
      case "approval": {
        const agent = agents.find((a) => a.approval?.id === msg.id);
        if (agent) decideApproval(agent, msg.decision, "commander");
        break;
      }
      case "declare_incident":
        declareIncident(msg.title.trim() || "Production incident");
        break;
      case "incident_status":
        setIncidentStatus(msg.status, "commander");
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

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".md": "text/markdown; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
};

// Uploads, agent outputs, and the command bar's routing preview.
async function workApi(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  url: URL,
  json: (status: number, body: unknown) => void,
): Promise<void> {
  if (url.pathname === "/api/uploads" && req.method === "POST") {
    const name = basename(url.searchParams.get("name") || "file").replace(/[^\w.\- ]/g, "_");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_UPLOAD) return json(413, { error: "File is larger than 50 MB" });
      chunks.push(c as Buffer);
    }
    const id = randomUUID();
    mkdirSync(join(UPLOADS, id), { recursive: true });
    writeFileSync(join(UPLOADS, id, name), Buffer.concat(chunks));
    const upload: Upload = { id, name, size };
    return json(200, upload);
  }
  if (url.pathname === "/api/preview" && req.method === "POST") {
    const { text, attachments } = JSON.parse(await readBody(req)) as { text: string; attachments?: string[] };
    const v = await router.preview(text, {
      pendingPlan: missions.find((m) => m.status === "awaiting_approval")?.view() ?? null,
      agents: agents.map((a) => a.view()),
      rules: rules.list(),
      recent: recent.slice(-4),
      pendingClarification,
      incident: incident?.view() ?? null,
      attachments,
    });
    return json(200, { target: v.target, intent: v.intent, incidentAction: v.incidentAction, instruction: v.instruction });
  }
  const m = url.pathname.match(/^\/api\/agents\/(\d+)\/outputs(?:\/(.+))?$/);
  const agent = m && agents.find((a) => a.id === m[1]);
  if (!m || !agent) return json(404, { error: "not found" });
  const dir = join(agent.cwd, "outputs");
  if (!m[2]) {
    const files: OutputFile[] = existsSync(dir)
      ? readdirSync(dir)
          .filter((n) => !n.startsWith("."))
          .map((n) => ({ name: n, ...statOf(join(dir, n)) }))
          .filter((f) => f.isFile)
          .map(({ name, size, modifiedAt }) => ({ name, size, modifiedAt }))
          .sort((a, b) => a.name.localeCompare(b.name))
      : [];
    return json(200, files);
  }
  const file = join(dir, basename(decodeURIComponent(m[2]))); // basename: no escaping the folder
  if (!existsSync(file)) return json(404, { error: "no such output" });
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

function statOf(path: string) {
  const st = statSync(path);
  return { size: st.size, modifiedAt: st.mtimeMs, isFile: st.isFile() };
}

// Incident endpoints: postmortem, Jamie call notes, and Jamie's webhook.
async function incidentApi(req: import("node:http").IncomingMessage, url: URL, json: (status: number, body: unknown) => void): Promise<void> {
  if (url.pathname === "/api/jamie/meetings" && req.method === "GET") {
    if (!jamie.configured) return json(200, { configured: false, meetings: [] });
    return json(200, { configured: true, meetings: await jamie.list(10) });
  }
  // Jamie calls this when a meeting is processed (needs a public HTTPS URL, e.g. a tunnel).
  if (url.pathname === "/webhooks/jamie" && req.method === "POST") {
    const secret = process.env.JAMIE_WEBHOOK_KEY;
    if (!secret || req.headers["x-jamie-api-key"] !== secret) return json(401, { error: "bad webhook key" });
    const body = JSON.parse(await readBody(req)) as { data: Omit<JamieMeeting, "id" | "transcript"> & { transcript: { speakerName: string; text: string }[] } };
    if (incident) {
      callNotes = { ...body.data, id: "webhook", transcript: body.data.transcript.map((t) => `**${t.speakerName}** ${t.text}`).join("\n") };
      incident.jamieMeetingId = callNotes.id;
      incident.log("action", `Call notes received from Jamie: ${body.data.title}`, "Jamie");
    }
    return json(200, { ok: true });
  }
  if (!incident) return json(404, { error: "no active incident" });
  if (url.pathname === "/api/incident/jamie" && req.method === "POST") {
    const { meetingId } = JSON.parse(await readBody(req)) as { meetingId: string };
    callNotes = await jamie.get(meetingId);
    incident.jamieMeetingId = meetingId;
    incident.log("action", `Call notes attached from Jamie: ${callNotes.title}`, "commander");
    return json(200, { title: callNotes.title });
  }
  if (url.pathname === "/api/incident/postmortem" && req.method === "GET") {
    return json(200, { markdown: incident.postmortem });
  }
  if (url.pathname === "/api/incident/postmortem" && req.method === "POST") {
    const runs = telemetry.listRuns({ limit: 100 }).filter((r) => r.startedAt >= incident!.declaredAt - 5000);
    incident.postmortem = await writePostmortem(incident, runs, callNotes);
    // Incidents live in memory; keep the write-up and its source timeline on disk.
    const dir = join(ROOT, "data", "postmortems");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${incident.id}.md`), incident.postmortem);
    writeFileSync(join(dir, `${incident.id}.timeline.json`), JSON.stringify(incident.view(), null, 2));
    broadcastIncident();
    return json(200, { markdown: incident.postmortem });
  }
  json(404, { error: "not found" });
}

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
