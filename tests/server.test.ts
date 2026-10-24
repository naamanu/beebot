import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, request, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { writeJsonAtomic } from "../server/persistence.ts";
import type { MissionView, ServerMsg } from "../server/types.ts";

function modelReply(res: ServerResponse, value: unknown) {
  if (res.destroyed) return;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "test", content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
}

async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

test("local server protects controls, restores task-owned data and discards work after reset", { timeout: 30_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "beebot-server-test-"));
  const data = join(root, "data");
  const workspace = join(root, "work");
  mkdirSync(workspace);
  const archived: MissionView = { id: "saved-task", title: "Saved task", quick: true, request: "Saved work", template: "general", files: [], status: "running", plan: null, revisions: [], allocation: null, workers: [{ name: "Worker", agentId: "1", state: "running" }], leadAgentId: null, costUsd: 0, createdAt: 1, endedAt: null, error: null };
  const savedAgent = { id: "1", task: "Saved work", cwd: workspace, status: "working", events: [{ at: 2, kind: "result", text: "Saved work finished" }], runId: null, costUsd: 0, sessionId: null, template: "general", mission: { id: archived.id, role: "Worker" } };
  writeJsonAtomic(join(data, "session.json"), { run: { dir: workspace, repo: workspace }, missions: [archived], agents: [savedAgent, { ...savedAgent, id: "2", mission: undefined }, { ...savedAgent, id: "3", mission: { id: "missing-task", role: "Orphan" } }], decisions: [], recent: [] });

  let holdRouter = false;
  let ballot = { target: "new", intent: "assign", instruction: "Prepare a report", incident_action: "none" };
  const heldVotes: ServerResponse[] = [];
  const heldPlans: ServerResponse[] = [];
  const provider = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const prompt = JSON.stringify(input.messages);
    if (prompt.includes("Write a title of 2 to 6 words")) return modelReply(res, "Test task");
    if (prompt.includes("Operator just said:")) {
      if (holdRouter) { heldVotes.push(res); return; }
      return modelReply(res, ballot);
    }
    heldPlans.push(res);
  });
  const speech = new WebSocketServer({ noServer: true });
  let rejectSpeech = true;
  const speechAudio: Buffer[] = [];
  provider.on("upgrade", (req, socket, head) => {
    if (rejectSpeech) { socket.end("HTTP/1.1 401 Unauthorized\r\nX-Error-Message: Test rejection\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return; }
    speech.handleUpgrade(req, socket, head, (client) => {
      client.on("message", (raw, binary) => {
        if (binary) speechAudio.push(Buffer.from(raw as Buffer));
        else if (JSON.parse(raw.toString()).type === "flush_request") {
          client.send(JSON.stringify({ type: "turn_start" }));
          client.send(JSON.stringify({ type: "turn_end_candidate", text: "Prepare a voice report" }));
          client.send(JSON.stringify({ type: "turn_end" }));
        }
      });
    });
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const providerAddress = provider.address();
  assert.ok(providerAddress && typeof providerAddress === "object");
  const child = spawn(process.execPath, ["--import", "tsx", resolve("server/index.ts")], {
    cwd: resolve("."),
    env: { ...process.env, PORT: "0", CONTROL_TOWER_DATA_DIR: data, CONTROL_TOWER_WORK_DIR: root, ANTHROPIC_API_KEY: "test-placeholder", ANTHROPIC_BASE_URL: `http://127.0.0.1:${providerAddress.port}`, RESON8_API_KEY: "test-speech-key", RESON8_TURNS_URL: `ws://127.0.0.1:${providerAddress.port}/turns`, JAMIE_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (chunk) => { logs += chunk; });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  let ws: WebSocket | undefined;
  t.after(async () => {
    ws?.terminate();
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await once(child, "exit");
    }
    for (const client of speech.clients) client.terminate();
    speech.close();
    provider.closeAllConnections();
    await new Promise<void>((done) => provider.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  });
  const port = await waitFor(() => logs.match(/server on 127\.0\.0\.1:(\d+)/)?.[1], "server startup").catch((error) => { throw new Error(`${error.message}\n${logs}`); });
  const base = `http://127.0.0.1:${port}`;
  const bootstrap = () => fetch(`${base}/api/session`, { method: "POST", headers: { "x-control-tower": "session" } });
  const boot = await bootstrap();
  assert.equal(boot.status, 200);
  const cookie = boot.headers.get("set-cookie")!.split(";")[0]!;
  const api = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { cookie, ...init.headers } });

  await t.test("HTTP and WebSocket controls require a trusted local session", async () => {
    assert.equal((await fetch(`${base}/api/runs`)).status, 401);
    assert.equal((await fetch(`${base}/api/session`, { method: "POST" })).status, 403);
    assert.equal((await fetch(`${base}/api/session`, { method: "POST", headers: { "x-control-tower": "session", origin: "https://untrusted.example" } })).status, 403);
    assert.equal((await api("/api/runs", { headers: { origin: "https://untrusted.example" } })).status, 401);
    assert.equal((await api("/api/runs")).status, 200);
    const hostStatus = await new Promise<number | undefined>((done, reject) => {
      const req = request(`${base}/api/session`, { method: "POST", headers: { host: "untrusted.example", "x-control-tower": "session" } }, (res) => { res.resume(); done(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(hostStatus, 403);
    const denied = new WebSocket(`${base.replace("http", "ws")}/ws`);
    const error = await once(denied, "error");
    assert.match(String(error[0]), /401/);
  });

  const messages: ServerMsg[] = [];
  ws = new WebSocket(`${base.replace("http", "ws")}/ws`, { headers: { cookie } });
  ws.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
  await once(ws, "open");
  const send = (message: unknown) => ws!.send(JSON.stringify(message));
  const latestState = () => messages.findLast((message) => message.type === "state");

  await t.test("restoration drops legacy agents and missing task references", async () => {
    const state = await waitFor(latestState, "restored state");
    assert.equal(state.agents.length, 1);
    assert.equal(state.tasks.length, 1);
    assert.deepEqual(state.tasks[0]!.agentIds, ["1"]);
    assert.equal(state.agents[0]!.status, "idle");
    assert.equal(state.tasks[0]!.status, "ready");
  });

  await t.test("marking a reviewable task done updates the task and persists completion", async () => {
    send({ type: "complete_task", taskId: archived.id });
    await waitFor(() => latestState()?.tasks[0]?.status === "done" ? true : undefined, "completed task");
    assert.ok(latestState()!.missions[0]!.endedAt);
    await waitFor(() => {
      const saved = JSON.parse(readFileSync(join(data, "session.json"), "utf8"));
      return saved.missions[0]?.status === "done" ? true : undefined;
    }, "persisted task completion");
  });

  await t.test("a new assignment addressed to an agent creates another task", async () => {
    ballot = { target: "1", intent: "assign", instruction: "A separate report", incident_action: "none" };
    send({ type: "say", text: "Agent one, next task: a separate report", taskId: archived.id, template: "general", plan: true });
    await waitFor(() => heldPlans.length ? true : undefined, "separate task planner");
    assert.equal(latestState()!.tasks.length, 2);
    assert.equal(latestState()!.agents[0]!.task, savedAgent.task);
    assert.equal(latestState()!.tasks.find((task) => task.id === archived.id)!.request, archived.request);
    const newTask = latestState()!.tasks.find((task) => task.id !== archived.id)!;
    const beforeCompletion = messages.length;
    send({ type: "complete_task", taskId: newTask.id });
    await waitFor(() => messages.slice(beforeCompletion).find((message) => message.type === "notice" && message.level === "error" && message.text.includes("not ready")), "premature completion rejection");
    assert.equal(latestState()!.tasks.find((task) => task.id === newTask.id)!.status, "planning");
    ballot = { target: "all", intent: "stop", instruction: "Stop this task", incident_action: "none" };
    send({ type: "say", text: "Stop all work on this task", taskId: newTask.id });
    await waitFor(() => latestState()?.tasks.find((task) => task.id === newTask.id)?.status === "stopped" ? true : undefined, "task cancellation");
    assert.equal(latestState()!.agents[0]!.status, "idle", "stopping a task must not touch another task's agents");
    send({ type: "reset" });
    await waitFor(() => latestState()?.tasks.length === 0 ? true : undefined, "reset after assignment");
    heldPlans.length = 0;
    ballot = { target: "new", intent: "assign", instruction: "Prepare a report", incident_action: "none" };
  });

  await t.test("invalid messages and oversized JSON return errors without crashing", async () => {
    ws!.send("{");
    send({ type: "say", text: 42 });
    await waitFor(() => messages.filter((message) => message.type === "notice" && message.level === "error").length >= 2 ? true : undefined, "protocol errors");
    assert.equal((await api("/api/preview", { method: "POST", body: "{" })).status, 400);
    assert.equal((await api("/api/preview", { method: "POST", body: JSON.stringify({ text: "x".repeat(1024 * 1024 + 1) }) })).status, 413);
    assert.equal((await api("/api/runs")).status, 200);
  });

  await t.test("speech failure is visible and a retry relays audio with the selected planning context", async () => {
    send({ type: "mic", on: true });
    send({ type: "mic", on: false });
    const failure = await waitFor(() => messages.find((message) => message.type === "mic_state" && message.status === "error"), "speech connection failure");
    assert.match(failure.type === "mic_state" ? failure.error! : "", /401.*Test rejection/);
    rejectSpeech = false;
    send({ type: "command_context", context: { template: "general", plan: true, attachments: [], taskId: null, uploading: false } });
    send({ type: "mic", on: true });
    await waitFor(() => messages.find((message) => message.type === "mic_state" && message.status === "listening"), "speech retry");
    const pcm = Buffer.from([1, 2, 3, 4]);
    ws!.send(pcm);
    send({ type: "mic", on: false });
    await waitFor(() => heldPlans.length ? true : undefined, "voice planner request");
    assert.deepEqual(speechAudio, [pcm]);
    assert.equal(latestState()!.missions[0]!.template, "general");
    assert.equal(latestState()!.missions[0]!.quick, false);
    assert.equal(latestState()!.agents.length, 0);
    send({ type: "reset" });
    await waitFor(() => latestState()?.tasks.length === 0 ? true : undefined, "reset after speech test");
    heldPlans.length = 0;
  });

  await t.test("reset aborts planning and cannot restore a late plan", async () => {
    send({ type: "say", text: "Prepare a report", template: "general", plan: true, attachments: [] });
    await waitFor(() => heldPlans.length ? true : undefined, "planner request");
    send({ type: "reset" });
    await waitFor(() => latestState()?.tasks.length === 0 ? true : undefined, "empty task list");
    for (const res of heldPlans) modelReply(res, { summary: "Late report", steps: [{ id: "S1", title: "Report", detail: "Write report", dependsOn: [] }], risks: [] });
    await delay(100);
    assert.equal(latestState()!.tasks.length, 0);
    assert.equal(latestState()!.agents.length, 0);
  });

  await t.test("reset also discards a late router decision and queued commands", async () => {
    holdRouter = true;
    send({ type: "say", text: "Another report", template: "general", plan: true });
    send({ type: "say", text: "Queued report", template: "general", plan: true });
    await waitFor(() => heldVotes.length === 5 ? true : undefined, "five held router votes");
    send({ type: "reset" });
    for (const res of heldVotes) modelReply(res, { target: "new", intent: "assign", instruction: "Late task", incident_action: "none" });
    await delay(400);
    assert.equal(latestState()!.tasks.length, 0);
    assert.equal(heldVotes.length, 5);
    const persisted = JSON.parse(readFileSync(join(data, "session.json"), "utf8"));
    assert.equal(persisted.agents.length, 0);
    assert.equal(persisted.missions.length, 0);
    assert.equal((await api("/api/runs")).status, 200);
  });
});
