import "dotenv/config";
import { copyFileSync, cpSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { ZodError } from "zod";
import { ControlAccess } from "./access.ts";
import { Agent, type AgentSnapshot } from "./agents.ts";
import { INCIDENT_ROLES, Incident } from "./incident/incident.ts";
import { Jamie, type JamieMeeting } from "./incident/jamie.ts";
import { writePostmortem } from "./incident/postmortem.ts";
import { ShopfrontSim } from "./incident/sim.ts";
import { Watchtower, anomalyBriefing, type Anomaly } from "./watch/watchtower.ts";
import { closingBriefing, incidentBriefing, type BriefingState } from "./watch/briefing.ts";
import { Mission, fallbackTitle, type SpawnRequest } from "./missions/mission.ts";
import { shortTitle } from "./missions/title.ts";
import { recoverAgent, recoverMission } from "./missions/recovery.ts";
import { buildTasks, isRecovered } from "./tasks.ts";
import { OperatorInput } from "./operator.ts";
import { writeJsonAtomic } from "./persistence.ts";
import { clientMessageSchema, HttpError, parseJson, previewSchema } from "./protocol.ts";
import { Reson8Turns } from "./reson8.ts";
import { Router, clarifyingQuestion } from "./router.ts";
import { RuleBook } from "./rules.ts";
import { Telemetry } from "./telemetry.ts";
import type { Approval, Decision, Proposal, IncidentStatus, MissionView, OutputFile, RouteVerdict, RunStatus, ServerMsg, Template, Upload } from "./types.ts";
import { DEFAULT_TASKS, addScratchDir, addWorktree, createRun, nextAgentId, repoFiles, type Run } from "./workspace.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 8787);
const AGENT_MODEL = process.env.AGENT_MODEL || "claude-opus-5-5";
const ROUTER_MODEL = process.env.ROUTER_MODEL || "claude-haiku-5-5";
const ROUTER_VOTES = Number(process.env.ROUTER_VOTES || 5);

const DATA = process.env.CONTROL_TOWER_DATA_DIR ?? join(ROOT, "data");
const WORK = process.env.CONTROL_TOWER_WORK_DIR ?? ROOT;
const SESSION_FILE = join(DATA, "session.json");
const UPLOADS = join(DATA, "uploads");
const UNDO_MS = 2000; // a new agent can be cancelled for this long before it starts
const MAX_UPLOAD = 50 * 1024 * 1024;
const TEMPLATE = join(ROOT, "demo", "template");

const rules = new RuleBook(join(DATA, "rules.json"));
const telemetry = new Telemetry(join(DATA, "telemetry.db"));
telemetry.onChange(() => broadcast({ type: "telemetry" }));
const router = new Router(ROUTER_MODEL, ROUTER_VOTES);
const jamie = new Jamie(process.env.JAMIE_API_KEY);
const clients = new Set<WebSocket>();
const access = new ControlAccess(process.env.CONTROL_TOWER_UI_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean));
let session = new AbortController();

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
// Production, watched continuously: healthy until a bad deploy lands.
const production = new ShopfrontSim(Date.now(), { outage: false });
const watchtower = new Watchtower(production, (a) => onAnomaly(a));
let lastBriefing: { at: number; state: BriefingState } | null = null;
let proposals: Proposal[] = [];
// Planned tasks. Live missions run here; after a restart, earlier ones come
// back read-only (their agents are restored, the orchestration is not).
let missions: Mission[] = [];
let archivedMissions: MissionView[] = [];

function broadcast(msg: ServerMsg): void {
  const data = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === c.OPEN) c.send(data);
}

function missionViews(): MissionView[] {
  return [...missions.map((m) => m.view()), ...archivedMissions];
}

function tasks() {
  return buildTasks(
    agents.map((a) => a.view()),
    missionViews(),
    incident?.view() ?? null,
  );
}

function state(): ServerMsg {
  return { type: "state", watch: watchtower.view(), proposals: proposals.filter((p) => p.status === "open"), tasks: tasks(), agents: agents.map((a) => a.view()), rules: rules.list(), decisions, incident: incident?.view() ?? null, missions: missionViews() };
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
  saveTimer = setTimeout(() => {
    try { saveNow(); }
    catch (error) {
      console.error("Could not save the session:", error);
      broadcast({ type: "notice", level: "error", text: "The session could not be saved. Check available disk space and directory permissions." });
    }
  }, 300);
}

function saveNow(): void {
  clearTimeout(saveTimer);
  const data: SavedSession = { run, agents: agents.map((a) => a.snapshot()), decisions, recent: recent.slice(-10), missions: missionViews() };
  writeJsonAtomic(SESSION_FILE, data);
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
  const signal = session.signal;
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
    onStatus: () => {
      if (!signal.aborted) { broadcast(state()); save(); }
    },
    onFinished: (agentId, ok) => {
      if (signal.aborted || !mission) return;
      missions.find((candidate) => candidate.id === mission.id)?.onAgentFinished(agentId, ok);
    },
    onEvent: (agentId, event, status) => {
      if (signal.aborted) return;
      const agent = agents.find((a) => a.id === agentId);
      broadcast({ type: "agent_event", id: agentId, event, status, runId: agent?.runId ?? null, costUsd: agent?.costUsd ?? 0 });
      save();
    },
  });
}

function restoreSession(): void {
  if (!existsSync(SESSION_FILE)) { telemetry.closeOrphans(new Set()); return; }
  try {
    const saved = JSON.parse(readFileSync(SESSION_FILE, "utf8")) as SavedSession;
    if (saved.run && !existsSync(saved.run.repo)) { telemetry.closeOrphans(new Set()); return; }
    run = saved.run;
    decisions = saved.decisions ?? [];
    recent = saved.recent ?? [];
    const taskIds = new Set((saved.missions ?? []).map((m) => m.id));
    // Incident agents can't come back: their simulated production is gone.
    agents = saved.agents
      .filter((a) => a.mission && taskIds.has(a.mission.id) && existsSync(a.cwd) && a.template !== "incident")
      .map((a) => {
        a = recoverAgent(a);
        return makeAgent(a.id, a.task, a.cwd, a, a.mission?.role, undefined, a.mission);
      });
    // Missions that were mid-flight can't resume their orchestration.
    archivedMissions = (saved.missions ?? []).map((m) => recoverMission(m, agents.map((agent) => agent.view())));
    // Missions saved before short titles existed get one now.
    const signal = session.signal;
    for (const m of archivedMissions.filter((x) => !x.title)) {
      m.title = fallbackTitle(m.request);
      void shortTitle(m.request, signal).then((t) => {
        if (!t || signal.aborted) return;
        m.title = t;
        broadcast(state());
        save();
      });
    }
    telemetry.closeOrphans(new Set());
    console.log(`Restored ${archivedMissions.length} task(s) with ${agents.length} agent(s).`);
  } catch (err) {
    console.warn(`Could not restore the last session: ${(err as Error).message}`);
    telemetry.closeOrphans(new Set());
  }
}

function resetSession(): void {
  session.abort();
  session = new AbortController();
  for (const mission of missions) mission.cancel();
  for (const a of agents) a.close("reset");
  agents = [];
  missions = [];
  proposals = [];
  archivedMissions = [];
  endIncident();
  run = null;
  recent = [];
  decisions = [];
  pendingClarification = null;
  saveNow();
  broadcast(state());
}

function startSession(demoTasks: string[]): void {
  resetSession();
  for (const task of demoTasks) createMission(task, "coding", [], { quick: true });
  broadcast({ type: "notice", level: "info", text: `Started ${demoTasks.length} demo tasks` });
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
    baseAgentIds = [] as string[],
  } = {},
): Agent {
  if (!mission) throw new Error("Agents must be created within a task.");
  run ??= createRun(WORK, TEMPLATE);
  const id = nextAgentId(run);
  const cwd = template === "general" ? addScratchDir(run, id) : addWorktree(run, id, baseAgentIds);
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

function createMission(request: string, template: "general" | "coding", files: AttachedFile[], { quick = false } = {}): Mission {
  const signal = session.signal;
  const mission = new Mission(
    {
      template,
      request,
      files: files.map((f) => ({ name: f.name, size: f.size, head: readHead(f.path) })),
      repoFiles: template === "coding" ? repoFiles(TEMPLATE) : [],
    },
    {
      spawn: (m, req) => {
        if (signal.aborted) throw new Error("The session was reset.");
        return spawnAgent(req.task, {
          quiet: true,
          template: m.template,
          files,
          mission: { id: m.id, role: req.role ?? "", title: req.title },
          undo: req.undo,
          inputsFrom: req.inputsFrom,
          baseAgentIds: req.baseAgentIds,
        }).id;
      },
      stop: (id, reason) => agents.find((agent) => agent.id === id)?.close("reset", reason),
      changed: () => {
        if (signal.aborted) return;
        broadcast(state());
        save();
      },
      speak: (text) => { if (!signal.aborted) broadcast({ type: "speak", text }); },
    },
  );
  missions = [mission, ...missions];
  if (quick) mission.startQuick();
  else void mission.start();
  save();
  // A short title for the task list arrives a moment later.
  void shortTitle(request, signal).then((t) => { if (t && !signal.aborted && mission.status !== "cancelled") mission.setTitle(t); });
  return mission;
}

function decidePlan(missionId: string | null, decision: "approve" | "revise" | "cancel", note = ""): void {
  const mission = missionId ? missions.find((m) => m.id === missionId) : missions.find((m) => m.status === "awaiting_approval");
  if (!mission) return;
  if (decision === "approve") void mission.approve();
  else if (decision === "revise") void mission.revise(note);
  else {
    mission.cancel();
  }
}

function completeTask(taskId: string): void {
  const task = tasks().find((candidate) => candidate.id === taskId);
  if (!task) throw new Error("This task is no longer available.");
  if (task.status === "done") return;
  if (task.status !== "ready") throw new Error("The task is not ready to finish. All required agents must finish and pending approvals must be resolved first.");
  if (task.kind === "incident") setIncidentStatus("resolved", "commander");
  else {
    const mission = missions.find((candidate) => candidate.id === taskId);
    if (mission) {
      if (!mission.complete()) throw new Error("The task is not ready to finish.");
    } else {
      const archived = archivedMissions.find((candidate) => candidate.id === taskId);
      if (!archived || archived.status !== "ready") throw new Error("The task is not ready to finish.");
      archived.status = "done";
      archived.endedAt = Date.now();
    }
  }
  save();
  broadcast(state());
}

function cancelStart(id: string): void {
  const agent = agents.find((a) => a.id === id);
  if (!agent?.cancelStart()) return;
  agent.close("reset");
  agents = agents.filter((a) => a !== agent);
  // A quick task whose only agent was cancelled disappears with it.
  missions = missions.filter((m) => !(m.quick && m.view().workers.every((w) => w.agentId === id)));
  broadcast(state());
  broadcast({ type: "notice", level: "info", text: `Cancelled agent ${id} before it started.` });
  save();
}

// --- Incidents ---

// Start an incident with four investigators. Other tasks keep running.
// by "watchtower": declared proactively on the production being watched.
function declareIncident(title: string, { by = "commander", anomaly = null as Anomaly | null } = {}): void {
  // Only the previous incident's investigators are replaced.
  for (const a of agents.filter((x) => x.template === "incident")) a.close("reset");
  agents = agents.filter((x) => x.template !== "incident");
  endIncident();
  // A manual drill on a healthy store gets the classic outage, already 9 minutes in.
  if (!production.broken && by === "commander") production.injectOutage(Date.now() - 9 * 60_000, Date.now() - 6 * 60_000);
  incident = new Incident(title, "SEV1", jamie, () => broadcastIncident(), production, by);
  callNotes = null;
  lastBriefing = null;
  run ??= createRun(WORK, TEMPLATE);
  for (const role of INCIDENT_ROLES) {
    const id = nextAgentId(run);
    const agent = makeAgent(id, `${role.task} Incident: ${title}.`, addScratchDir(run, id), undefined, role.name);
    agents.push(agent);
    agent.begin();
  }
  // Metrics move continuously; push them to the UI while the incident is open.
  incidentTimer = setInterval(() => {
    broadcastIncident();
    maybeBrief();
  }, 2000);
  broadcast(state());
  broadcast({ type: "speak", text: anomaly ? anomalyBriefing(anomaly) : `Incident declared: ${title}. Four investigators are on it.` });
  save();
}

// The watchtower saw a sustained spike: act on it unless an incident is open.
function onAnomaly(a: Anomaly): void {
  if (incident && incident.status !== "resolved") return;
  const title = a.suspect ? `Checkout errors at ${Math.round(a.errorRate)}% after deploy #${a.suspect.id}` : `Checkout errors at ${Math.round(a.errorRate)}%`;
  declareIncident(title, { by: "watchtower", anomaly: a });
  incident?.log("finding", `Watchtower: checkout error rate ${a.errorRate.toFixed(1)}% sustained since ${new Date(a.since).toLocaleTimeString()}${a.suspect ? `; most recent deploy before it: #${a.suspect.id} (${a.suspect.service}, ${a.suspect.author})` : ""}.`, "watchtower");
}

// Action items from a review call become suggested work: the tower offers,
// the commander decides.
function proposeFollowUps(notes: JamieMeeting | null): void {
  const items = (notes?.tasks ?? []).filter((t) => !t.completed).map((t) => (t.assignee?.name ? `${t.content} (owner: ${t.assignee.name})` : t.content));
  if (!items.length) return;
  const proposal: Proposal = { id: randomUUID().slice(0, 8), source: "jamie", title: `Follow-ups from “${notes!.title}”`, items, createdAt: Date.now(), status: "open" };
  proposals = [proposal, ...proposals.filter((p) => p.status === "open")].slice(0, 5);
  broadcast(state());
  broadcast({ type: "speak", text: `Jamie sent ${items.length} action item${items.length === 1 ? "" : "s"} from the review. Want agents on ${items.length === 1 ? "it" : "them"}? Say “start the follow-ups”.` });
  save();
}

function acceptProposal(id: string | null): void {
  const p = proposals.find((x) => x.status === "open" && (id === null || x.id === id));
  if (!p) return;
  p.status = "accepted";
  // Code-shaped items get a coding agent; the rest a general one.
  for (const item of p.items) createMission(item, /\b(alert|test|config|code|deploy|review|pool|monitor|dashboard)\b/i.test(item) ? "coding" : "general", [], { quick: true });
  broadcast(state());
  broadcast({ type: "speak", text: `Started ${p.items.length} follow-up task${p.items.length === 1 ? "" : "s"}.` });
  save();
}

function dismissProposal(id: string | null): void {
  const p = proposals.find((x) => x.status === "open" && (id === null || x.id === id));
  if (!p) return;
  p.status = "dismissed";
  broadcast(state());
  save();
}

// Called off as a false alarm: stop the investigators and close it.
function standDown(by: string): void {
  if (!incident || incident.status === "resolved") return;
  for (const a of agents.filter((x) => x.template === "incident" && x.status === "working")) void a.stop("Stood down by the commander");
  incident.log("status", "Stood down: called off by the commander", by);
  setIncidentStatus("resolved", by);
  watchtower.disarm();
  broadcast({ type: "speak", text: "Standing down. I'll keep watching production." });
}

// A spoken update during an incident, at most every 45 seconds and only
// when something changed. Approval prompts are spoken separately.
function maybeBrief(): void {
  if (!incident || incident.status === "resolved") return;
  if (lastBriefing && Date.now() - lastBriefing.at < 45_000) return;
  const view = incident.view();
  const b = incidentBriefing(view, agents.map((a) => a.view()), lastBriefing?.state ?? null);
  if (!lastBriefing) {
    // First call just records the starting point; the declaration was the first briefing.
    lastBriefing = { at: Date.now(), state: b?.state ?? lastBriefing!.state };
    return;
  }
  if (!b) return;
  lastBriefing = { at: Date.now(), state: b.state };
  broadcast({ type: "speak", text: b.text });
}

function setIncidentStatus(status: IncidentStatus, by: string): void {
  if (!incident) return;
  const wasOpen = incident.status !== "resolved";
  incident.setStatus(status, by);
  if (status === "resolved") {
    clearInterval(incidentTimer);
    if (wasOpen && !/Stood down/.test(incident.timeline.at(-2)?.text ?? "")) broadcast({ type: "speak", text: closingBriefing(incident.view()) });
  }
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
    const view = incident?.view() ?? null;
    broadcast({ type: "incident", incident: view });
    announceRecovery(view);
  });
}

// Once errors are back to normal after a fix, say so (once per incident) and
// offer to close it. The commander still decides.
let recoveryAnnouncedFor: string | null = null;
function announceRecovery(view: ReturnType<Incident["view"]> | null): void {
  if (!incident || !view || recoveryAnnouncedFor === view.id) return;
  if (view.status === "resolved" || incident.sim.fixedAt === null || !isRecovered(view)) return;
  recoveryAnnouncedFor = view.id;
  incident.log("status", "Checkout errors are back to normal", "tower");
  broadcast({ type: "speak", text: "Checkout errors are back to normal. Say “resolve the incident” when you're ready to close it." });
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
  taskId?: string | null; // the task the operator is looking at
}

function hear(utterance: string, focused: string | null, opts: HearOptions = {}): void {
  const signal = session.signal;
  routing = routing.then(() => {
    if (!signal.aborted) return routeAndApply(utterance, focused, opts, signal);
  }).catch((err) => {
    if (!signal.aborted) broadcast({ type: "notice", level: "error", text: err instanceof Error ? err.message : String(err) });
  });
}

async function routeAndApply(utterance: string, focused: string | null, opts: HearOptions, signal: AbortSignal): Promise<void> {
  broadcast({ type: "routing", utterance });
  // Viewing a task: instructions are about its agents (and its plan).
  const task = opts.taskId ? tasks().find((t) => t.id === opts.taskId) : undefined;
  if (opts.taskId && !task) throw new Error("This task is no longer available. Select a task or start a new one.");
  const scoped = task ? agents.filter((a) => task.agentIds.includes(a.id)) : agents;
  const verdict = await router.route(utterance, {
    agents: scoped.map((a) => a.view()),
    viewingTask: task ? task.title : null,
    newTaskMode: !task,
    pendingProposal: proposals.find((p) => p.status === "open") ?? null,
    rules: rules.list(),
    recent: recent.slice(-4),
    pendingClarification,
    focused: scoped.some((a) => a.id === focused) ? focused : null,
    incident: incident?.view() ?? null,
    attachments: opts.files?.map((f) => f.name),
    pendingPlan: (task?.missionId ? missions.find((m) => m.id === task.missionId && m.status === "awaiting_approval") : missions.find((m) => m.status === "awaiting_approval"))?.view() ?? null,
  }, undefined, signal);
  if (signal.aborted) return;
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
  if (verdict.action === "applied") await apply(verdict, opts, signal);
}

function remember(d: Decision): void {
  decisions = [d, ...decisions].slice(0, 30);
  save();
}

async function apply(v: RouteVerdict, opts: HearOptions, signal: AbortSignal): Promise<void> {
  const task = opts.taskId ? tasks().find((t) => t.id === opts.taskId) : undefined;
  const scoped = task ? agents.filter((a) => task.agentIds.includes(a.id)) : agents;
  if (v.intent === "incident") {
    if (v.incidentAction === "declare") declareIncident(v.instruction || "Production incident");
    else if (v.incidentAction === "stand_down") standDown("commander (voice)");
    else if (v.incidentAction !== "none") setIncidentStatus(v.incidentAction, "commander (voice)");
    return;
  }
  // An answer to work the tower suggested.
  if (v.target === "proposal") {
    if (v.intent === "approve") acceptProposal(null);
    else if (v.intent === "stop") dismissProposal(null);
    return;
  }
  // A plan is waiting for approval and this answers it.
  if (v.target === "plan") {
    const missionId = opts.taskId && missions.some((m) => m.id === opts.taskId) ? opts.taskId : null;
    if (v.intent === "approve") decidePlan(missionId, "approve");
    else if (v.intent === "stop") decidePlan(missionId, "cancel");
    else decidePlan(missionId, "revise", v.instruction || v.utterance);
    return;
  }
  incident?.log("instruction", `“${v.utterance}” → ${v.intent} ${v.target === "all" ? "all agents" : `agent ${v.target}`}`, "commander");
  // Yes or no to an agent that is waiting for approval.
  const waiting = scoped.filter((a) => a.approval && (v.target === a.id || v.target === "all"));
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
  if (v.intent === "stop" && v.target === "all" && task?.missionId) {
    decidePlan(task.missionId, "cancel");
    return;
  }
  if (v.intent === "assign" && v.target !== "all") {
    // With the Incident chip selected and no incident yet, new work starts one.
    if (opts.template === "incident" && !incident) {
      declareIncident(v.instruction);
      return;
    }
    const kind = scoped.find((a) => a.id === v.target)?.template ?? opts.template ?? "general";
    const template = kind === "general" || opts.files?.length ? "general" : "coding";
    createMission(v.instruction, template, opts.files ?? [], { quick: opts.plan === false });
    return;
  }
  // Files attached to an instruction for an existing agent go into its workspace.
  if (opts.files?.length && v.target !== "all") {
    const target = agents.find((a) => a.id === v.target);
    if (target) v = { ...v, instruction: v.instruction + attach(opts.files, target.cwd, target.template === "general" ? "inputs" : "attachments") };
  }
  const targets = v.target === "all" ? scoped : scoped.filter((a) => a.id === v.target);
  for (const a of targets) {
    if (signal.aborted) return;
    if (v.intent !== "assign") a.traceRouter(v); // assign opens a fresh run; trace it there
    if (v.intent === "assign") {
      // One task for everyone makes no sense; "all" + assign is treated as a correction.
      a.correct(v.instruction);
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
  const json = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  };
  const fail = (err: unknown) => {
    if (res.headersSent) { res.destroy(); return; }
    json(err instanceof HttpError ? err.status : err instanceof ZodError || err instanceof SyntaxError ? 400 : 500, { error: err instanceof Error ? err.message : String(err) });
  };
  try {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/api/session") {
    return access.bootstrap(req, res) ? json(200, { ok: true }) : json(403, { error: "Session bootstrap requires a trusted local request." });
  }
  if (url.pathname.startsWith("/api/") && !access.authenticated(req)) {
    return json(401, { error: "Open the Control Tower UI to establish a local session." });
  }
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
        taskId: url.searchParams.get("taskId") || undefined,
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
  } catch (error) { fail(error); }
});

const wss = new WebSocketServer({
  server: http,
  path: "/ws",
  maxPayload: 1024 * 1024,
  verifyClient: ({ req }: { req: import("node:http").IncomingMessage }) => access.authenticated(req),
});

wss.on("connection", (ws) => {
  clients.add(ws);
  let mic: Reson8Turns | null = null;
  const drainingMics = new Set<Reson8Turns>();
  const operator = new OperatorInput();
  const send = (m: ServerMsg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
  send(state());

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      mic?.send(data as Buffer);
      return;
    }
    try {
    const msg = clientMessageSchema.parse(parseJson(data.toString()));
    switch (msg.type) {
      case "start":
        try {
          startSession(msg.tasks.length ? msg.tasks : DEFAULT_TASKS);
        } catch (err) {
          send({ type: "notice", level: "error", text: `Could not start agents: ${(err as Error).message}` });
        }
        break;
      case "say":
        if (msg.text.trim())
          hear(msg.text.trim(), operator.focused, { template: msg.template, files: resolveUploads(msg.attachments), plan: msg.plan, taskId: msg.taskId });
        break;
      case "command_context":
        operator.context = msg.context;
        break;
      case "mic":
        if (msg.on && !mic) {
          const key = process.env.RESON8_API_KEY;
          if (!key) {
            send({ type: "mic_state", status: "error", error: "Voice is unavailable: RESON8_API_KEY is not set in .env." });
            break;
          }
          send({ type: "mic_state", status: "connecting" });
          let signal = session.signal;
          const captureTurn = () => { operator.beginVoiceTurn(); return operator.endVoiceTurn(); };
          let turn = captureTurn();
          const current = new Reson8Turns(key, phrases(), {
            onReady: () => { if (mic === current) send({ type: "mic_state", status: "listening" }); },
            onClose: () => {
              drainingMics.delete(current);
              if (mic !== current) return;
              mic = null;
              send({ type: "mic_state", status: "stopped" });
            },
            onTurnStart: () => { signal = session.signal; turn = captureTurn(); },
            onInterim: (text) => { if (!signal.aborted) send({ type: "transcript", text, final: false }); },
            onTurn: (text) => {
              if (signal.aborted || ws.readyState !== ws.OPEN) return;
              send({ type: "transcript", text, final: true });
              if (turn.context.uploading) {
                send({ type: "notice", level: "error", text: "Wait for the file uploads to finish, then repeat the instruction." });
                return;
              }
              hear(text, turn.focused, { template: turn.context.template, plan: turn.context.plan, taskId: turn.context.taskId, files: resolveUploads(turn.context.attachments) });
            },
            onError: (error) => {
              drainingMics.delete(current);
              if (mic && mic !== current) return;
              mic = null;
              send({ type: "mic_state", status: "error", error });
            },
          }, process.env.RESON8_TURNS_URL);
          mic = current;
        } else if (!msg.on && mic) {
          drainingMics.add(mic);
          mic.close();
          mic = null;
          send({ type: "mic_state", status: "stopped" });
        }
        break;
      case "focus":
        operator.focused = msg.id;
        break;
      case "select_task":
        operator.context.taskId = msg.id;
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
      case "complete_task":
        completeTask(msg.taskId);
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
      case "watch_toggle":
        watchtower.enabled = msg.on;
        broadcast({ type: "watch", watch: watchtower.view() });
        broadcast({ type: "speak", text: msg.on ? "Watching production." : "I've stopped watching production." });
        break;
      case "simulate_outage":
        // Demo: a bad deploy lands on the healthy store; the watchtower should notice.
        if (!production.broken) {
          const { badDeployId } = production.injectOutage();
          broadcast({ type: "notice", level: "info", text: `Simulated: deploy #${badDeployId} just landed on payments-api.` });
        }
        break;
      case "accept_proposal":
        acceptProposal(msg.id);
        break;
      case "dismiss_proposal":
        dismissProposal(msg.id);
        break;
    }
    } catch (error) {
      send({ type: "notice", level: "error", text: error instanceof ZodError ? "Invalid control message. Check its type and fields." : error instanceof Error ? error.message : String(error) });
    }
  });

  const abortMics = () => {
    mic?.abort();
    mic = null;
    for (const current of drainingMics) current.abort();
    drainingMics.clear();
  };
  ws.on("error", abortMics);

  ws.on("close", () => {
    clients.delete(ws);
    abortMics();
  });
});

async function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req.iterator({ destroyOnReturn: false })) {
    size += (c as Buffer).length;
    if (size > 1024 * 1024) { req.resume(); throw new HttpError(413, "JSON requests must be at most 1 MB."); }
    chunks.push(c as Buffer);
  }
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
    const { text, attachments, taskId } = previewSchema.parse(parseJson(await readBody(req)));
    const task = taskId ? tasks().find((t) => t.id === taskId) : undefined;
    if (taskId && !task) throw new HttpError(404, "Task not found.");
    const scoped = task ? agents.filter((a) => task.agentIds.includes(a.id)) : agents;
    const v = await router.preview(text, {
      pendingPlan: (task?.missionId ? missions.find((m) => m.id === task.missionId && m.status === "awaiting_approval") : missions.find((m) => m.status === "awaiting_approval"))?.view() ?? null,
      viewingTask: task?.title ?? null,
      newTaskMode: !task,
      agents: scoped.map((a) => a.view()),
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
  res.writeHead(200, {
    "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'",
  });
  createReadStream(file).on("error", () => res.destroy()).pipe(res);
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
      proposeFollowUps(callNotes);
    }
    return json(200, { ok: true });
  }
  if (!incident) return json(404, { error: "no active incident" });
  if (url.pathname === "/api/incident/jamie" && req.method === "POST") {
    const { meetingId } = parseJson(await readBody(req)) as { meetingId: string };
    if (typeof meetingId !== "string" || !meetingId.trim()) throw new HttpError(400, "meetingId is required.");
    const current = incident;
    const notes = await jamie.get(meetingId);
    if (incident !== current) throw new HttpError(409, "The incident changed while the notes were loading.");
    callNotes = notes;
    current.jamieMeetingId = meetingId;
    current.log("action", `Call notes attached from Jamie: ${callNotes.title}`, "commander");
    proposeFollowUps(callNotes);
    return json(200, { title: callNotes.title });
  }
  if (url.pathname === "/api/incident/postmortem" && req.method === "GET") {
    return json(200, { markdown: incident.postmortem });
  }
  if (url.pathname === "/api/incident/postmortem" && req.method === "POST") {
    const current = incident;
    const runs = telemetry.listRuns({ limit: 100 }).filter((r) => r.startedAt >= current.declaredAt - 5000);
    const markdown = await writePostmortem(current, runs, callNotes);
    if (incident !== current) throw new HttpError(409, "The incident changed while the postmortem was being generated.");
    current.postmortem = markdown;
    // Incidents live in memory; keep the write-up and its source timeline on disk.
    const dir = join(DATA, "postmortems");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${current.id}.md`), markdown);
    writeJsonAtomic(join(dir, `${current.id}.timeline.json`), current.view());
    broadcastIncident();
    return json(200, { markdown: incident.postmortem });
  }
  json(404, { error: "not found" });
}

restoreSession();

// The watchtower looks at production every few seconds, unasked.
setInterval(() => {
  watchtower.check();
  broadcast({ type: "watch", watch: watchtower.view() });
}, 5000);

http.listen(PORT, "127.0.0.1", () => {
  const address = http.address();
  console.log(`Control Tower server on 127.0.0.1:${typeof address === "object" ? address?.port : PORT}  (agents: ${AGENT_MODEL}, router: ${ROUTER_MODEL} × ${ROUTER_VOTES} votes)`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn("⚠ ANTHROPIC_API_KEY is not set in .env");
  if (!process.env.RESON8_API_KEY) console.warn("⚠ RESON8_API_KEY is not set in .env (typed input still works)");
});

// Save before exiting so a restart picks up exactly where we left off.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    session.abort();
    for (const mission of missions) if (["planning", "allocating"].includes(mission.status)) mission.cancel();
    try { saveNow(); }
    catch (error) { console.error("Could not save the session during shutdown:", error); }
    for (const a of agents) a.close("shutdown");
    telemetry.close();
    process.exit(0);
  });
}
