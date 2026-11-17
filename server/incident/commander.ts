import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Agent } from "../agents.ts";
import { writeJsonAtomic } from "../persistence.ts";
import type { ProductionSource } from "../production/source.ts";
import { HttpError } from "../protocol.ts";
import { isRecovered } from "../tasks.ts";
import type { IncidentStatus, IncidentView, Proposal, RunRow, ServerMsg, WatchView } from "../types.ts";
import { closingBriefing, incidentBriefing, type BriefingState } from "../watch/briefing.ts";
import { Watchtower, anomalyBriefing, type Anomaly } from "../watch/watchtower.ts";
import { Incident, type IncidentRecord } from "./incident.ts";
import type { Jamie, JamieMeeting } from "./jamie.ts";
import { writePostmortem } from "./postmortem.ts";
import { reviewEvidence } from "./recommendation.ts";
import type { IncidentStore } from "./store.ts";
import type { IncidentSummary } from "./store.ts";

// What the commander needs from the rest of the server. Agents, missions and
// transport stay in index.ts; the incident lifecycle lives here.
export interface CommanderDeps {
  production: ProductionSource;
  store: IncidentStore;
  jamie: Jamie;
  dataDir: string;
  broadcast(msg: ServerMsg): void;
  changed(): void; // full state changed: rebroadcast it
  save(): void; // persist the session (agents, missions)
  investigators(): Agent[]; // live agents working incidents
  closeInvestigators(): void;
  spawnInvestigators(title: string): void;
  runsSince(at: number): RunRow[];
  startFollowUp(item: string): void;
}

const capitalize = (s: string) => (s ? `${s[0]!.toUpperCase()}${s.slice(1)}` : s);

// Owns the active incident from detection to postmortem: the watchtower,
// declarations, evidence reviews and fix proposals, spoken briefings, Jamie
// follow-ups and persistence.
export class IncidentCommander {
  incident: Incident | null = null;
  readonly watchtower: Watchtower;
  private callNotes: JamieMeeting | null = null; // the war-room call, from Jamie
  private proposals: Proposal[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private watchTimer: ReturnType<typeof setInterval> | undefined;
  private lastBriefing: { at: number; state: BriefingState } | null = null;
  private recoveryAnnouncedFor: string | null = null;
  private broadcastPending = false;
  private checking: Promise<void> | null = null;

  constructor(private deps: CommanderDeps) {
    this.watchtower = new Watchtower(deps.production, (a) => this.onAnomaly(a));
  }

  private get production(): ProductionSource {
    return this.deps.production;
  }

  private broadcast(msg: ServerMsg): void {
    this.deps.broadcast(msg);
  }

  // --- Views ---

  view(): IncidentView | null {
    return this.incident?.view() ?? null;
  }

  watchView(): WatchView {
    return this.watchtower.view();
  }

  openProposals(): Proposal[] {
    return this.proposals.filter((p) => p.status === "open");
  }

  pendingProposal(): Proposal | null {
    return this.proposals.find((p) => p.status === "open") ?? null;
  }

  history(limit = 50): IncidentSummary[] {
    return this.deps.store.list(limit);
  }

  record(id: string): IncidentRecord | null {
    return this.incident?.id === id ? this.incident.record() : this.deps.store.get(id);
  }

  // --- Lifecycle ---

  // Start an incident with four investigators. Other tasks keep running.
  // by "watchtower": declared proactively on the production being watched.
  declare(title: string, { by = "commander", anomaly = null as Anomaly | null } = {}): void {
    // Only the previous incident's investigators are replaced.
    this.deps.closeInvestigators();
    this.end();
    // A manual drill on a healthy simulated store gets the classic outage, already 9 minutes in.
    const demo = this.production.demo;
    if (demo && !demo.broken && by === "commander") demo.injectOutage(Date.now() - 9 * 60_000, Date.now() - 6 * 60_000);
    this.incident = new Incident(title, "SEV1", this.deps.jamie, () => this.broadcastIncident(), this.production, { declaredBy: by, detectedAt: anomaly?.since ?? null });
    void this.incident.refresh();
    this.callNotes = null;
    this.lastBriefing = null;
    this.deps.spawnInvestigators(title);
    this.startTimer();
    this.deps.changed();
    this.broadcast({ type: "speak", text: anomaly ? anomalyBriefing(anomaly) : `Incident declared: ${title}. Four investigators are on it.` });
    this.deps.save();
  }

  // An incident open when the server stopped comes back for review and
  // write-up. Its investigators and in-flight review do not.
  restore(): void {
    try {
      const saved = this.deps.store.lastOpen();
      if (!saved) return;
      const incident = new Incident(saved.title, saved.severity, this.deps.jamie, () => this.broadcastIncident(), this.production, { restore: saved });
      this.incident = incident;
      incident.log("instruction", "Server restarted: this incident was restored from disk. Its investigators did not resume; start new work or resolve it when ready.", "tower");
      if (saved.source.id !== this.production.id) incident.log("instruction", `Production source changed from ${saved.source.label} to ${this.production.label}; live metrics now come from the new source.`, "tower");
      void incident.refresh();
      this.startTimer();
      console.log(`Restored open incident ${saved.id}: ${saved.title}`);
    } catch (err) {
      console.warn(`Could not restore the last incident: ${(err as Error).message}`);
    }
  }

  setStatus(status: IncidentStatus, by: string): void {
    const incident = this.incident;
    if (!incident) return;
    const wasOpen = incident.status !== "resolved";
    incident.setStatus(status, by);
    if (status === "resolved") {
      clearInterval(this.timer);
      incident.review.invalidate();
      this.dismissFixes(incident.id);
      this.deps.changed();
      const stoodDown = /Stood down/.test(incident.timeline.at(-2)?.text ?? "");
      if (wasOpen && !stoodDown) {
        this.broadcast({ type: "speak", text: closingBriefing(incident.view()) });
        // The postmortem writes itself; a false alarm doesn't get one.
        void this.generatePostmortem().catch((err) => console.warn(`Postmortem failed: ${(err as Error).message}`));
      }
    }
    this.broadcastIncident();
  }

  // Called off as a false alarm: stop the investigators and close it.
  standDown(by: string): void {
    const incident = this.incident;
    if (!incident || incident.status === "resolved") return;
    for (const a of this.deps.investigators().filter((x) => x.status === "working")) void a.stop("Stood down by the commander");
    incident.log("status", "Stood down: called off by the commander", by);
    this.setStatus("resolved", by);
    this.watchtower.disarm();
    this.broadcast({ type: "speak", text: "Standing down. I'll keep watching production." });
  }

  // The session was reset: drop the incident and every proposal.
  reset(): void {
    this.proposals = [];
    this.end();
  }

  // Save the incident now (e.g. at shutdown).
  persist(): void {
    if (!this.incident) return;
    try { this.deps.store.save(this.incident.record()); }
    catch (error) { console.error("Could not save the incident:", error); }
  }

  stop(): void {
    clearInterval(this.timer);
    clearInterval(this.watchTimer);
  }

  private end(): void {
    clearInterval(this.timer);
    const incident = this.incident;
    if (incident) {
      incident.review.invalidate();
      this.dismissFixes(incident.id);
      // Replaced or reset while still open: record that, so it isn't restored later.
      if (incident.status !== "resolved") {
        incident.timeline.push({ at: Date.now(), kind: "status", text: "Closed without resolution: replaced by a new incident or a session reset", by: "tower" });
        incident.status = "resolved";
        this.persist();
      }
    }
    this.incident = null;
    this.callNotes = null;
  }

  // Metrics move continuously; poll production and push to the UI while the incident is open.
  private startTimer(): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => {
      const current = this.incident;
      if (!current) return;
      void current.refresh().then(() => {
        if (this.incident !== current) return;
        this.broadcastIncident();
        this.maybeBrief();
        this.maybeProposeFix();
      });
    }, 2000);
  }

  // Coalesces bursts of changes into one broadcast and one save.
  broadcastIncident(): void {
    if (this.broadcastPending) return;
    this.broadcastPending = true;
    setImmediate(() => {
      this.broadcastPending = false;
      const view = this.view();
      this.broadcast({ type: "incident", incident: view });
      this.announceRecovery(view);
      if (this.incident) {
        try { this.deps.store.save(this.incident.record()); }
        catch (err) { console.warn(`Could not save incident ${this.incident.id}: ${(err as Error).message}`); }
      }
    });
  }

  // Once errors are back to normal after a fix, say so (once per incident) and
  // offer to close it. The commander still decides.
  private announceRecovery(view: IncidentView | null): void {
    const incident = this.incident;
    if (!incident || !view || this.recoveryAnnouncedFor === view.id) return;
    if (view.status === "resolved" || incident.fixAppliedAt === null || !isRecovered(view)) return;
    this.recoveryAnnouncedFor = view.id;
    const back = `${capitalize(this.production.health.label)} are back to normal`;
    incident.log("status", back, "tower");
    this.broadcast({ type: "speak", text: `${back}. Say “resolve the incident” when you're ready to close it.` });
  }

  // A spoken update during an incident, at most every 45 seconds and only
  // when something changed. Approval prompts are spoken separately.
  private maybeBrief(): void {
    const incident = this.incident;
    if (!incident || incident.status === "resolved") return;
    if (this.lastBriefing && Date.now() - this.lastBriefing.at < 45_000) return;
    const b = incidentBriefing(incident.view(), this.deps.investigators().map((a) => a.view()), this.lastBriefing?.state ?? null);
    if (!this.lastBriefing) {
      // First call just records the starting point; the declaration was the first briefing.
      if (b) this.lastBriefing = { at: Date.now(), state: b.state };
      return;
    }
    if (!b) return;
    this.lastBriefing = { at: Date.now(), state: b.state };
    this.broadcast({ type: "speak", text: b.text });
  }

  // --- Watching production ---

  // The watchtower looks at production every few seconds, unasked. A slow
  // backend never stacks checks.
  startWatching(intervalMs = 5000): void {
    this.checkProduction();
    clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => this.checkProduction(), intervalMs);
  }

  checkProduction(): void {
    this.checking ??= this.watchtower.check()
      .then(() => this.broadcast({ type: "watch", watch: this.watchtower.view() }))
      .catch((err) => console.warn(`Watchtower check failed: ${(err as Error).message}`))
      .finally(() => { this.checking = null; });
  }

  setWatching(on: boolean): void {
    this.watchtower.enabled = on;
    this.broadcast({ type: "watch", watch: this.watchtower.view() });
    this.broadcast({ type: "speak", text: on ? "Watching production." : "I've stopped watching production." });
  }

  // The watchtower saw a sustained spike: act on it unless an incident is open.
  private onAnomaly(a: Anomaly): void {
    if (this.incident && this.incident.status !== "resolved") return;
    const label = this.production.health.label;
    const title = `${capitalize(label)} at ${Math.round(a.errorRate)}%${a.suspect ? ` after deploy #${a.suspect.id}` : ""}`;
    this.declare(title, { by: "watchtower", anomaly: a });
    this.incident?.log("finding", `Watchtower: ${label} at ${a.errorRate.toFixed(1)}% sustained since ${new Date(a.since).toLocaleTimeString()}${a.suspect ? `; most recent deploy before it: #${a.suspect.id} (${a.suspect.service}, ${a.suspect.author})` : ""}.`, "watchtower");
  }

  // --- Demo drills (simulator only) ---

  simulateOutage(scenario: "deploy" | "provider" = "deploy"): void {
    const demo = this.production.demo;
    if (!demo) throw new HttpError(409, `Drills need the simulator; production is ${this.production.label}.`);
    if (demo.broken) return;
    if (this.incident && this.incident.status !== "resolved") throw new HttpError(409, "Resolve or stand down the current incident before starting another drill.");
    if (scenario === "provider") {
      demo.injectProviderOutage();
      this.broadcast({ type: "notice", level: "info", text: "Simulated: the external payment provider is returning 503s. No local deploy caused this outage." });
    } else {
      const { badDeployId } = demo.injectOutage();
      this.broadcast({ type: "notice", level: "info", text: `Simulated: deploy #${badDeployId} just landed on payments-api.` });
    }
  }

  recoverProvider(): void {
    if (!this.production.demo?.recoverProvider()) throw new HttpError(409, "There is no active provider outage to recover.");
    this.incident?.log("action", "Demo: the external payment provider has restored service. No local rollback was applied.", "simulator");
    this.broadcastIncident();
    this.broadcast({ type: "notice", level: "info", text: "Simulated provider recovery. Checkout errors will fall over about 45 seconds." });
  }

  // --- Evidence review and fix proposals ---

  investigatorsBusy(): boolean {
    return this.deps.investigators().some((a) => a.status === "working" || a.status === "starting" || a.status === "blocked" || a.approval);
  }

  retryReview(): void {
    const incident = this.incident;
    if (!incident || incident.status === "resolved" || incident.review.view.state === "reviewing") return;
    incident.review.invalidate();
    this.dismissFixes(incident.id);
    this.maybeProposeFix();
  }

  skipInvestigation(incidentId: string, by: string): void {
    const incident = this.incident;
    if (!incident || incident.id !== incidentId) throw new HttpError(409, "That incident is no longer current.");
    if (incident.status === "resolved") return;
    if (this.investigatorsBusy()) throw new HttpError(409, "Let the investigators finish or stop them before skipping further checks.");
    incident.skipInvestigation(by);
    this.setStatus("resolved", by);
    // The explicit demo reset is immediate; refresh health and re-arm the
    // watchtower now so the UI and next drill don't wait for the next tick.
    this.checkProduction();
  }

  private dismissFixes(incidentId: string): boolean {
    let changed = false;
    for (const p of this.proposals) if (p.incidentId === incidentId && p.status === "open") { p.status = "dismissed"; changed = true; }
    return changed;
  }

  // Review recorded findings and visible deploy records after investigators stop.
  // Remaining errors alone never justify a rollback.
  maybeProposeFix(): void {
    const current = this.incident;
    if (!current || current.status === "resolved") return;
    const investigators = this.deps.investigators();
    if (!investigators.length || this.investigatorsBusy() || current.fixAppliedAt !== null || isRecovered(current.view())) {
      const hadReview = current.review.view.state !== "none";
      current.review.invalidate();
      if (this.dismissFixes(current.id) || hadReview) this.deps.changed();
      return;
    }
    const evidence = reviewEvidence(current.findings, current.deploys);
    if (current.review.matches(evidence)) return;
    this.dismissFixes(current.id);
    const work = current.review.run(evidence);
    this.deps.changed();
    void work.then((decision) => {
      if (this.incident !== current || current.status === "resolved") return;
      if (this.investigatorsBusy() || current.fixAppliedAt !== null || isRecovered(current.view()) || !current.review.matches(reviewEvidence(current.findings, current.deploys))) {
        current.review.invalidate();
        this.deps.changed();
        return;
      }
      if (!decision) {
        this.deps.changed();
        if (current.review.view.state === "error") {
          current.log("recommendation", `Evidence review failed: ${current.review.view.error}. No fix proposed.`, "tower");
          this.broadcast({ type: "notice", level: "error", text: "The evidence review failed. No fix was proposed. Retry it from the incident view." });
        }
        return;
      }
      const citations = decision.findingIds.map((id) => `Finding ${id}: ${evidence.findings.find((f) => f.id === id)!.text}`);
      current.log("recommendation", `${decision.action === "rollback" ? `Recommend rolling back #${decision.deployId}` : "Further investigation needed"}: ${decision.reason}${citations.length ? `\n${citations.join("\n")}` : ""}${decision.missingEvidence.length ? `\nNext checks: ${decision.missingEvidence.join("; ")}` : ""}`, "tower");
      if (decision.action === "rollback") {
        const proposal: Proposal = {
          id: randomUUID().slice(0, 8), source: "tower", incidentId: current.id,
          title: `Roll back deploy #${decision.deployId}?`,
          items: [decision.reason, ...citations], createdAt: Date.now(), status: "open",
          action: { type: "rollback", deployId: decision.deployId! },
        };
        this.proposals = [proposal, ...this.openProposals()].slice(0, 5);
        this.broadcast({ type: "speak", text: `The recorded findings support rolling back deploy ${decision.deployId}. ${decision.reason} Approve?` });
      } else {
        this.broadcast({ type: "speak", text: `I don't have evidence for a rollback. ${decision.reason} Next: ${decision.missingEvidence.join("; ")}` });
      }
      this.deps.changed();
    });
  }

  acceptProposal(id: string | null): void {
    const p = this.proposals.find((x) => x.status === "open" && (id === null || x.id === id));
    if (!p) return;
    if (p.action?.type === "rollback") {
      // Recheck the evidence and target when a delayed voice approval arrives.
      const current = this.incident;
      const deployId = p.action.deployId;
      const target = current?.deploys.find((d) => d.id === deployId);
      if (!current || current.id !== p.incidentId || current.status === "resolved" ||
        !current.review.matches(reviewEvidence(current.findings, current.deploys)) ||
        current.review.view.decision?.action !== "rollback" || current.review.view.decision.deployId !== deployId ||
        this.investigatorsBusy() || !target || target.rolledBackAt !== null || target.at > Date.now() || current.fixAppliedAt !== null) {
        p.status = "dismissed";
        this.deps.changed();
        this.broadcast({ type: "notice", level: "error", text: "That recommendation is no longer current. Review the latest findings before approving a fix." });
        return;
      }
      p.status = "accepted";
      current.log("approval", `Approved: roll back deploy #${deployId}`, "commander");
      this.deps.changed();
      this.deps.save();
      void current.rollback(deployId, "tower").then(
        (result) => this.broadcast(result.ok
          ? { type: "speak", text: `Rolling back deploy ${deployId}. I'll tell you when errors are back to normal.` }
          : { type: "notice", level: "error", text: `The rollback did not go through: ${result.message}` }),
        (err) => {
          current.log("action", `Rollback of #${deployId} failed: ${(err as Error).message}`, "tower");
          this.broadcast({ type: "notice", level: "error", text: `The rollback failed: ${(err as Error).message}` });
        },
      );
      return;
    }
    p.status = "accepted";
    for (const item of p.items) this.deps.startFollowUp(item);
    this.deps.changed();
    this.broadcast({ type: "speak", text: `Started ${p.items.length} follow-up task${p.items.length === 1 ? "" : "s"}.` });
    this.deps.save();
  }

  dismissProposal(id: string | null): void {
    const p = this.proposals.find((x) => x.status === "open" && (id === null || x.id === id));
    if (!p) return;
    p.status = "dismissed";
    this.deps.changed();
    this.deps.save();
  }

  // --- Jamie and the postmortem ---

  // Action items from a review call become suggested work: the tower offers,
  // the commander decides.
  private proposeFollowUps(notes: JamieMeeting): number {
    const items = notes.tasks.filter((t) => !t.completed).map((t) => (t.assignee?.name ? `${t.content} (owner: ${t.assignee.name})` : t.content));
    if (!items.length) {
      this.broadcast({ type: "notice", level: "info", text: "Jamie notes attached, but no unfinished action items were supplied. Add tasks in Jamie and attach the meeting again to propose follow-ups." });
      return 0;
    }
    const proposal: Proposal = { id: randomUUID().slice(0, 8), source: "jamie", title: `Follow-ups from “${notes.title}”`, items, createdAt: Date.now(), status: "open" };
    this.proposals = [proposal, ...this.openProposals()].slice(0, 5);
    this.deps.changed();
    this.broadcast({ type: "speak", text: `Jamie sent ${items.length} action item${items.length === 1 ? "" : "s"} from the review. Want agents on ${items.length === 1 ? "it" : "them"}? Say “start the follow-ups”.` });
    this.deps.save();
    return items.length;
  }

  // Jamie's meeting.completed webhook. Without a loaded incident it attaches nothing.
  receiveCallNotes(notes: JamieMeeting): void {
    const incident = this.incident;
    if (!incident) return;
    this.callNotes = notes;
    incident.jamieMeetingId = notes.id;
    incident.log("action", `Call notes received from Jamie: ${notes.title}`, "Jamie");
    this.proposeFollowUps(notes);
  }

  async attachMeeting(meetingId: string): Promise<{ title: string; followUpCount: number }> {
    const current = this.requireIncident();
    const notes = await this.deps.jamie.get(meetingId);
    if (this.incident !== current) throw new HttpError(409, "The incident changed while the notes were loading.");
    this.callNotes = notes;
    current.jamieMeetingId = meetingId;
    current.log("action", `Call notes attached from Jamie: ${notes.title}`, "commander");
    return { title: notes.title, followUpCount: this.proposeFollowUps(notes) };
  }

  requireIncident(): Incident {
    if (!this.incident) throw new HttpError(404, "no active incident");
    return this.incident;
  }

  // Write the postmortem from the timeline, the agents' runs and any call
  // notes. Runs on resolve by itself; the Postmortem tab can also redo it.
  async generatePostmortem(): Promise<string> {
    const current = this.requireIncident();
    current.postmortemState = "writing";
    this.broadcastIncident();
    try {
      const runs = this.deps.runsSince(current.declaredAt - 5000);
      const markdown = await writePostmortem(current, runs, this.callNotes);
      if (this.incident !== current) throw new HttpError(409, "The incident changed while the postmortem was being generated.");
      current.postmortem = markdown;
      current.postmortemState = "ready";
      // Also keep a plain-file copy next to its source timeline.
      const dir = join(this.deps.dataDir, "postmortems");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${current.id}.md`), markdown);
      writeJsonAtomic(join(dir, `${current.id}.timeline.json`), current.view());
      return markdown;
    } catch (err) {
      current.postmortemState = current.postmortem ? "ready" : "error";
      throw err;
    } finally {
      this.broadcastIncident();
    }
  }
}
