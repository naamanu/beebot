# Roadmap: from hackathon prototype to portfolio product

Goal: a polished, self-contained demo that a reviewer can run in one command and
that works the same way against a real (small) production stack as against the
simulator. Not a hosted multi-tenant SaaS.

## Phase 1 — Foundation (done)

- [x] **`ProductionSource` interface** (`server/production/source.ts`). Metrics,
      logs, deploys, rollback, restart and status posts are reached only through
      it. The Shopfront simulator is one adapter (`server/production/simulator.ts`);
      demo-only controls (inject outage, provider recovery, demo reset) are an
      optional `demo` capability, so real sources never pretend to have them.
- [x] **Async-safe incident state.** The incident and watchtower poll the source
      and render from a cached snapshot, so slow HTTP backends never block the UI.
- [x] **Incidents survive restarts.** Every incident is stored in
      `data/incidents.db` (SQLite). An incident open at shutdown comes back
      marked as interrupted (its investigators do not), and resolved incidents
      stay available with their postmortems via `/api/incidents`.
- [x] **Split `server/index.ts`.** The incident lifecycle (watchtower, declare,
      evidence review, fix and follow-up proposals, briefings, Jamie notes,
      postmortem, persistence) lives in `IncidentCommander`
      (`server/incident/commander.ts`) with explicit dependencies and its own
      tests; `index.ts` keeps agents, missions, routing and transport.

## Phase 2 — Real backends

- **Demo stack (`docker compose up`)**: a tiny real Shopfront (checkout and
  payments services plus Postgres) instrumented with Prometheus and Loki, and a
  chaos script that ships a genuinely bad config through a real deploy.
- **`PrometheusLokiSource`**: PromQL for metrics, LogQL for logs, configured by
  a small YAML service map (service → queries). Restarts go through the
  compose/k8s API behind the same approval gate.
- **`GitHubDeploySource`**: deploy history and diffs from the GitHub
  Deployments/compare APIs; rollback = re-dispatch the deploy workflow at the
  previous SHA (approval still required).
- `PRODUCTION_SOURCE=simulator|stack` selects the backend; the UI always shows
  which one is live and labels simulated data.
- Generalise the watchtower from "checkout error rate" to configured SLO signals.

## Phase 3 — Product polish

- Incident history page (list, timeline replay, postmortem) on top of `/api/incidents`.
- First-run setup screen: which keys are configured, what works without them.
- Error and empty states for every panel; reconnect handling for the socket.
- CI (GitHub Actions: typecheck, tests, web build), a Dockerfile, and a LICENSE.

## Phase 4 — Show it off

- **Diagnosis eval harness**: run each scenario N times against the real models,
  score correct culprit, unsupported rollbacks avoided, time to recommendation and
  cost. Publish the table in the README.
- More scenarios (memory leak, bad feature flag, noisy-neighbour DB, cert expiry).
- README rewrite: architecture diagram, 60-second quick start, the eval results.
