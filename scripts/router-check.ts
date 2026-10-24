// Runs sample utterances through the router against fake agents (no coding agents started).
import "dotenv/config";
import { Router } from "../server/router.ts";
import type { AgentView } from "../server/types.ts";

const tasks = [
  "Add due dates and listOverdue(now).",
  "Add input validation to createTodo.",
  "Fix search() to be case-insensitive and match tags.",
  "Add a CLI at bin/todo.js.",
];
const agents: AgentView[] = tasks.map((task, i) => ({ id: String(i + 1), task, status: "working", events: [], costUsd: 0 }));
const router = new Router(process.env.ROUTER_MODEL || "claude-haiku-5-5", Number(process.env.ROUTER_VOTES || 5));

const samples = [
  "new agent, add a README section about the CLI",
  "agent four, once you're done, next task is adding a --json flag to list",
  "can someone write tests for completeTodo",
  "to stop, wrong file",
  "whoever's on search, also match partial tags",
  "from now on no new dependencies",
  "three looks good ship it",
  "make it check that",
  "hey can you grab me a coffee",
];
const cases: [string, AgentView[], string | null][] = [
  ...samples.map((u): [string, AgentView[], string | null] => [u, agents, null]),
  ["add due dates to todos", [], null], // nothing running yet
  ["also handle timezones", agents, "1"], // agent 1 is open full-screen
];
for (const [u, agentList, focused] of cases) {
  const v = await router.route(u, { agents: agentList, rules: [], recent: [], pendingClarification: null, focused });
  const split = v.votes.map((x) => `${x.target}/${x.intent}:${x.count}`).join(" ");
  console.log(`${JSON.stringify(u).padEnd(48)} → ${v.action.padEnd(8)} ${Math.round(v.confidence * 100)}%  ${v.ms}ms  [${split}]  ${v.instruction}`);
}
