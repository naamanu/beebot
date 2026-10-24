// Drives an incident drill over the WebSocket: declare by voice, watch, and
// approve the first rollback request. Prints a compact log.
import WebSocket from "ws";
const seconds = Number(process.argv[2] ?? 120);
const ws = new WebSocket("ws://localhost:8787/ws");
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s`;
let approved = new Set();
ws.on("open", () => ws.send(JSON.stringify({ type: "say", text: "declare an incident, checkout is failing" })));
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.type === "verdict") console.log(ts(), "verdict:", m.verdict.intent, m.verdict.incidentAction, m.verdict.target, m.verdict.action);
  if (m.type === "speak") console.log(ts(), "SPEAK:", m.text);
  if (m.type === "agent_event" && m.event.kind !== "text") console.log(ts(), `[${m.id}] ${m.event.kind}: ${m.event.text.slice(0, 120)}`);
  if (m.type === "state") {
    for (const a of m.agents) {
      if (a.approval && !approved.has(a.approval.id)) {
        approved.add(a.approval.id);
        const say = /Roll back deploy #482/.test(a.approval.summary) || /status page/i.test(a.approval.summary) ? "approve" : "no, hold off on that";
        console.log(ts(), `>> approval requested by ${a.id}: ${a.approval.summary} → saying "${say}"`);
        setTimeout(() => ws.send(JSON.stringify({ type: "say", text: say })), 1500);
      }
    }
  }
  if (m.type === "incident" && m.incident) {
    const last = m.incident.errorRate.at(-1);
    if (!globalThis.lastPrint || Date.now() - globalThis.lastPrint > 15000) {
      globalThis.lastPrint = Date.now();
      console.log(ts(), `incident ${m.incident.status} · checkout errors ${last?.v}% · findings ${m.incident.findings.length}`);
    }
  }
});
setTimeout(() => process.exit(0), seconds * 1000);
