import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Agent } from "../server/agents.ts";
import { IncidentCommander } from "../server/incident/commander.ts";
import { Jamie } from "../server/incident/jamie.ts";
import { IncidentStore } from "../server/incident/store.ts";
import { SimulatorSource } from "../server/production/simulator.ts";
import type { ServerMsg } from "../server/types.ts";

process.env.ANTHROPIC_API_KEY = "test-placeholder";

const tick = () => new Promise((r) => setImmediate(r));

function setup(t: TestContext, store = new IncidentStore(":memory:")) {
  const messages: ServerMsg[] = [];
  const spawned: string[] = [];
  const followUps: string[] = [];
  let investigators: Partial<Agent>[] = [];
  const source = new SimulatorSource();
  const commander = new IncidentCommander({
    production: source,
    store,
    jamie: new Jamie(undefined),
    dataDir: "/nonexistent",
    broadcast: (m) => messages.push(m),
    changed: () => {},
    save: () => {},
    investigators: () => investigators as Agent[],
    closeInvestigators: () => { investigators = []; },
    spawnInvestigators: (title) => {
      spawned.push(title);
      investigators = ["1", "2", "3", "4"].map((id) => ({ id, status: "working", approval: null, view: () => ({ id }) as never, stop: async () => {} }) as Partial<Agent>);
    },
    runsSince: () => [],
    startFollowUp: (item) => followUps.push(item),
  });
  t.after(() => commander.stop());
  const spoken = () => messages.flatMap((m) => (m.type === "speak" ? [m.text] : []));
  return { commander, store, source, messages, spawned, followUps, spoken, setIdle: () => investigators.forEach((a) => (a.status = "idle")) };
}

test("declaring starts investigators, injects the classic drill and announces it", async (t) => {
  const { commander, source, spawned, spoken } = setup(t);
  commander.declare("Checkout failing");
  assert.deepEqual(spawned, ["Checkout failing"]);
  assert.equal(source.demo.broken, true, "a manual declaration on a healthy simulator lands the drill");
  assert.match(spoken()[0]!, /Incident declared: Checkout failing/);
  await commander.incident!.refresh();
  assert.ok(commander.view()!.errorRate.length > 0);
});

test("a second drill is refused while an incident is open", (t) => {
  const { commander, source } = setup(t);
  commander.declare("First");
  source.demo.restore();
  assert.throws(() => commander.simulateOutage(), /Resolve or stand down/);
});

test("standing down resolves without a postmortem and disarms the watchtower", async (t) => {
  const { commander, spoken } = setup(t);
  commander.declare("False alarm");
  commander.standDown("commander");
  assert.equal(commander.view()!.status, "resolved");
  assert.equal(commander.view()!.postmortemState, "none");
  assert.match(spoken().at(-1)!, /Standing down/);
});

test("replacing an open incident closes it in the store so it is not restored", async (t) => {
  const { commander, store } = setup(t);
  commander.declare("First");
  const first = commander.incident!.id;
  await tick();
  assert.equal(store.lastOpen()?.id, first);
  await new Promise((r) => setTimeout(r, 2)); // incident ids are time-based
  commander.declare("Second");
  await tick();
  assert.equal(store.get(first)?.status, "resolved");
  assert.match(store.get(first)!.timeline.at(-1)!.text, /Closed without resolution/);
  assert.equal(store.lastOpen()?.id, commander.incident!.id);
});

test("a restarted commander restores the open incident as interrupted", async (t) => {
  const store = new IncidentStore(":memory:");
  const before = setup(t, store);
  before.commander.declare("Checkout failing");
  await tick();
  before.commander.stop();
  const after = setup(t, store);
  after.commander.restore();
  assert.equal(after.commander.view()?.title, "Checkout failing");
  assert.equal(after.commander.view()?.interrupted, true);
  assert.match(after.commander.view()!.timeline.at(-1)!.text, /Server restarted/);
});

test("Jamie action items become a proposal; accepting starts only unfinished items", (t) => {
  const { commander, followUps } = setup(t);
  commander.declare("Checkout failing");
  commander.receiveCallNotes({
    id: "webhook", title: "Review", summary: { short: "", markdown: "" }, transcript: "",
    tasks: [{ content: "Add a pool alert", completed: false, assignee: { name: "sam" } }, { content: "Done already", completed: true }],
  } as never);
  assert.equal(commander.openProposals().length, 1);
  commander.acceptProposal(null);
  assert.deepEqual(followUps, ["Add a pool alert (owner: sam)"]);
  assert.equal(commander.openProposals().length, 0);
});

test("skipping checks requires the current incident and idle investigators", (t) => {
  const { commander } = setup(t);
  assert.throws(() => commander.skipInvestigation("inc-old", "commander"), /no longer current/);
  commander.declare("Checkout failing");
  assert.throws(() => commander.skipInvestigation(commander.incident!.id, "commander"), /Let the investigators finish/);
});
