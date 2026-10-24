# Control Tower

Hand out work to Claude coding agents and steer them by voice.

Each task gets its own Claude agent in its own git worktree. You talk, Reson8 transcribes each turn, and a decision engine works out which agent you meant, what you want, and how sure it is:

```
mic → Reson8 (turns STT) → router: N parallel Haiku votes → act / ask / ignore → agent inbox
```

- **Confidence = vote agreement.** Each utterance is classified 5× independently. If ≥60% agree, it's applied. Otherwise the tower asks a clarifying question built from the vote split ("Did you mean agent 2 or agent 3?") and treats your next sentence as the answer.
- **Intents:**
  - `assign`: "new agent: …" spins up a new agent; "agent two, next task: …" hands an existing one its next task.
  - `stop`: interrupt.
  - `correct`: injected into the running turn.
  - `approve`: wrap up and commit.
  - `rule`: a standing rule for every agent, persisted in `data/rules.json`.
  - `chatter`: ignored.
- **Focus view:** open any agent to see its full history and message it directly. Voice commands that don't name an agent go to the open one, and the others keep working in the side strip. Press Esc to go back to the grid.
- **Survives restarts:** the session is saved to `data/session.json`. On restart, every agent is restored and any agent that was mid-task resumes its Claude session.

## Observability

The **Runs** tab traces every run: one piece of work by one agent, from the instruction that started it to its result. Traces are stored in `data/telemetry.db` (SQLite) and kept across sessions.

- **Overview:** totals for runs, success rate, spend (agents and router), tokens, p50/p95 duration, tool calls and router decisions; spend per run; and a table of all runs you can filter by status, agent or text.
- **Run detail:** a waterfall of spans, using OpenTelemetry GenAI names: `invoke_agent` (the run), `chat` (each model call), `execute_tool` (each tool call, with input, output and errors), plus the `router` vote and `operator` instruction behind each steer. When a correction makes the SDK start a new turn, the new run is linked back to the one it continues.
- **Numbers:** run tokens and cost come from the Agent SDK's own per-turn accounting. Router cost is estimated from token usage (`server/pricing.ts`).

## Run

```bash
npm install
# fill in .env: ANTHROPIC_API_KEY (router), RESON8_API_KEY (voice)
npm run dev        # server :8787 + UI http://localhost:5173
```

`npm run dev` doesn't restart the server when files change, so running agents aren't interrupted while you edit. Use `npm run dev:watch` if you want auto-restart. The session comes back either way.

The agents use `ANTHROPIC_API_KEY` if it's set, otherwise your Claude Code login. Without a Reson8 key, the typed input box goes through the same router.

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
npx tsx scripts/router-check.ts                 # routes sample utterances (no coding agents)
npx tsx scripts/voice-check.ts "agent two, stop" # speech → Reson8 → transcript
node scripts/e2e-assign.mjs "new agent: …" 15    # send one utterance to the running server and watch
```
