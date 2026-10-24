# Control Tower

Hand out work to Claude coding agents and steer them by voice.

Each request becomes a task with its own plan, agents and result. A task can use several workstreams and a lead; coding agents each have a git worktree. You talk, Reson8 transcribes each turn, and a decision engine works out which agent you meant, what you want, and how sure it is:

```
mic → Reson8 (turns STT) → router: N parallel Haiku votes → act / ask / ignore → agent inbox
```

- **Confidence = vote agreement.** Each utterance is classified 5× independently. Failed votes still count in the denominator. If ≥60% agree on the target, intent and incident action, it's applied. Otherwise the tower asks a clarifying question built from the vote split ("Did you mean agent 2 or agent 3?") and treats your next sentence as the answer.
- **Intents:**
  - `assign`: starts a new task, including when addressed to an existing agent. Follow-ups and corrections stay with the current task.
  - `stop`: interrupt.
  - `correct`: injected into the running turn.
  - `approve`: wrap up and commit.
  - `rule`: a standing rule for every agent, persisted in `data/rules.json`.
  - `chatter`: ignored.
- **Task view:** navigate by task, with its agents grouped beneath it. Open an agent for its history, outputs and direct messages. Commands within a selected task address that task’s agents; standing rules remain global.
- **Restarts:** task-owned agents and results are saved atomically to `data/session.json`. Tasks with saved successful results recover as ready for review. Interrupted tasks are marked failed and their agents paused; orchestration does not automatically resume. Legacy agents without a valid task are not restored.

## Starting work: the command bar

Everything starts in one place at the bottom of the Tower: type, or hold **Space** and talk into it (**⌘K** focuses it from anywhere).

- **Kinds of work:**
  - **General:** analysis, research and writing. Attach files by dropping, pasting or using the paperclip; they land in the agent's `inputs/`. Deliverables (a `report.md`, charts, CSVs) go to `outputs/` and show in the agent's **Outputs** panel. Data work runs with `uv run --with pandas …`, so nothing is installed system-wide.
  - **Code:** a new agent in its own git worktree of the demo repo.
  - **Incident:** declares an incident (see below).

  The selected kind only applies to *new* work. "Two, stop" still goes to agent 2.
- **Preview:** when you pause typing, one quick router vote shows where the instruction will go ("→ new General agent with the attached files", "→ agent 2 · stop"). Enter runs the full five-vote decision.
- **Undo:** a new agent waits 4 seconds before it starts, with an Undo button.
- **More:** the ⋯ menu has the four demo coding tasks, clearing standing rules, and resetting the board.

## Plan first: the planner decides how many agents

With **Plan first** on (the default), new General or Code work doesn't start an agent right away:

1. **Plan:** a planner (Claude Opus) reads the task and a preview of the inputs (attached files, or the repo's file list), then outlines 3–8 steps with their dependencies and any risks.
2. **Approve:** the plan appears as a card on the board. Approve, revise ("drop step 4, add a chart per region") or cancel, by voice ("approve the plan") or with the buttons. Revising re-plans with your note.
3. **Allocate:** only then does the planner decide how many agents to use (1–4). It groups the steps into workstreams, says which wait on others, and whether a lead should combine the results (the lead owns the final integration steps). Small or sequential work gets one agent; independent, substantial pieces get one each.
4. **Run:** workstreams and the lead appear together under the task. Dependent agents start only after every prerequisite succeeds: General agents receive their outputs, and Code agents inherit all prerequisite branches. Invalid or cyclic allocations fail before workers start. A worker failure stops the task and its other active workers. A General lead combines everyone's outputs into one report; a Code lead merges the branches and runs the tests. Stopping the task cancels pending planning and allocation as well as its active workers.
5. **Review and finish:** each agent becomes Done after its final result and SDK idle event, including any queued instructions. After all workstreams and the lead finish, the task becomes **Ready for review**. Review its result and choose **Mark done** to finish the task. Busy agents, missing dependencies, errors and pending approvals block completion.

Turn Plan first off for quick one-agent tasks. Missions are saved; after a restart, finished missions come back read-only. `node scripts/e2e-mission.mjs "<task>" coding` runs one over the WebSocket, and `npx tsx scripts/allocate-check.ts` shows how the allocator splits a fixed plan.

## Incident response

Say "declare an incident: checkout is failing" (or click **Declare incident**). Four investigators start on a simulated Shopfront outage:

- **Logs** finds the error signature and where the failures start.
- **Changes** matches recent deploys and config changes against when the impact began.
- **Metrics** measures the blast radius and rules red herrings in or out.
- **Comms** keeps the public status page up to date.

They reach production only through tools (`server/incident/`): logs, metrics, deploys and diffs, plus a shared findings log so they build on each other's work. They also have a search over past incident calls recorded with [Jamie](https://www.meetjamie.ai).

- **Spoken approvals:** a rollback, a restart or a status-page post pauses the agent. The tower asks out loud ("Changes, agent 2, wants to roll back deploy #482. Approve?"). Say "approve" or "no", or use the buttons.
- **Completion:** investigators finish independently. Once all have finished, review their findings and choose **Mark done** to resolve the incident; an agent finishing its report does not resolve it automatically.
- **Live status:** the incident bar shows severity, impact time and the checkout error rate, with production actions marked on it. Say "we're mitigated" or "resolve the incident" to change the status.
- **Postmortem:** generated from the incident timeline, every agent run, the approvals, the status posts and, if attached, the war-room call notes from Jamie. Saved to `data/postmortems/`.
- **The simulated outage:** deploy #482 cut the payments DB pool from 50 to 5. The red herrings are a CDN cache dip and an old search warning. Rolling back #482 fixes it; restarting only helps for a moment. Run `npx tsx scripts/sim-check.ts` to see it without agents, or `node scripts/e2e-incident.mjs` to run a whole drill over the WebSocket.

**Jamie:** set `JAMIE_API_KEY` (a personal key from Jamie, Settings → Developers) to search real past calls and attach the war-room call to the postmortem. Without it, the search uses two sample past incidents. Jamie's `meeting.completed` webhook can post to `/webhooks/jamie` (set `JAMIE_WEBHOOK_KEY`; it needs a public HTTPS URL, e.g. through a tunnel).

Incidents live in memory: a server restart ends the drill (the postmortem is kept on disk).

## Observability

The **Activity** tab traces every run: one piece of work by one agent, from the instruction that started it to its result. Traces are stored in `data/telemetry.db` (SQLite) and kept across sessions.

- **Overview:** totals for runs, success rate, spend (agents and router), tokens, p50/p95 duration, tool calls and router decisions; spend per run; and a table of all runs you can filter by status, agent or text.
- **Run detail:** a waterfall of spans, using OpenTelemetry GenAI names: `invoke_agent` (the run), `chat` (each model call), `execute_tool` (each tool call, with input, output and errors), plus the `router` vote and `operator` instruction behind each steer. When a correction makes the SDK start a new turn, the new run is linked back to the one it continues.
- **Numbers:** run tokens and cost come from the Agent SDK's own per-turn accounting. Router cost is estimated from token usage (`server/pricing.ts`).

## Run

```bash
npm install
# fill in .env: ANTHROPIC_API_KEY (router), RESON8_API_KEY (voice)
npm run dev        # server :8787 + UI http://localhost:5173
```

`npm run dev` doesn't restart the server when files change, so running agents aren't interrupted while you edit. Use `npm run dev:watch` if you want auto-restart. Saved tasks come back either way; interrupted orchestration requires review.

The agents use `ANTHROPIC_API_KEY` if it's set, otherwise your Claude Code login. Without a Reson8 key, the typed input box goes through the same router. Typed and spoken requests share the selected kind of work, plan setting, attachments and task context.

The backend binds to `127.0.0.1`. The UI establishes an HttpOnly local session cookie before API or WebSocket access. Other UI origins must be listed explicitly in `CONTROL_TOWER_UI_ORIGINS` (comma-separated). Local scripts use `scripts/tower-socket.mjs` for session bootstrap. `CONTROL_TOWER_DATA_DIR` and `CONTROL_TOWER_WORK_DIR` isolate saved state and workspaces for tests.

## Demo script

1. Hold **Space**: "New agent: add due dates to todos." Then: "Spin someone up to fix search so it ignores case."
2. "From now on, no new dependencies." → shows up as a standing rule on every agent.
3. "Two, stop. Use a custom ValidationError class instead."
4. Open agent 1 and say "also handle timezones". It goes to agent 1 because that's the one open.
5. "Make it check that." → too vague, so the tower asks which agent you mean.
6. "Three looks good, ship it."

Or click **Demo tasks** to start four ready-made tasks on the demo repo (`demo/template`, a tiny todo library).

## Checks

```bash
npm test                                        # local fixtures; no model API calls
npm run typecheck
npx vite build
npx tsx scripts/router-check.ts                 # routes sample utterances (no coding agents)
npx tsx scripts/voice-check.ts "agent two, stop" # speech → Reson8 → transcript
node scripts/e2e-assign.mjs "new agent: …" 15    # send one utterance to the running server and watch
```
