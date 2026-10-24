// Drives a planned mission: sends a task with Plan first, approves the plan by
// voice when it is ready, and logs the allocation and each agent's progress.
import WebSocket from "ws";
const [task, template = "coding", seconds = "300"] = process.argv.slice(2);
const ws = new WebSocket("ws://localhost:8787/ws");
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(0).padStart(3)}s`;
let approved = false;
let lastStatus = "";
ws.on("open", () => ws.send(JSON.stringify({ type: "say", text: task, template, plan: true })));
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.type === "speak") console.log(ts(), "SPEAK:", m.text);
  if (m.type === "verdict") console.log(ts(), "verdict:", m.verdict.target, m.verdict.intent, m.verdict.action);
  if (m.type === "agent_event" && /result|error|steer/.test(m.event.kind)) console.log(ts(), `[${m.id}] ${m.event.kind}: ${m.event.text.slice(0, 140).replace(/\n/g, " ")}`);
  if (m.type !== "state") return;
  const mission = m.missions[0];
  if (!mission) return;
  if (mission.status !== lastStatus) {
    lastStatus = mission.status;
    console.log(ts(), "mission:", mission.status);
    if (mission.status === "awaiting_approval") for (const s of mission.plan.steps) console.log("     ", s.id, s.title, s.dependsOn.length ? `(after ${s.dependsOn})` : "");
    if (mission.allocation && mission.status === "running") {
      console.log("      reasoning:", mission.allocation.reasoning);
      for (const w of mission.allocation.workstreams) console.log(`      ${w.name}: ${w.stepIds.join(" ")}${w.after.length ? ` after ${w.after}` : ""}`);
      console.log("      synthesis:", mission.allocation.synthesis);
    }
    if (/done|failed/.test(mission.status)) setTimeout(() => process.exit(0), 1000);
  }
  if (mission.status === "awaiting_approval" && !approved) {
    approved = true;
    setTimeout(() => ws.send(JSON.stringify({ type: "say", text: "looks good, approve the plan" })), 1500);
  }
  const workers = mission.workers.map((w) => `${w.name}=${w.state}${w.agentId ? `(#${w.agentId})` : ""}`).join(" ");
  if (workers && workers !== globalThis.lastWorkers) {
    globalThis.lastWorkers = workers;
    console.log(ts(), "workers:", workers, mission.leadAgentId ? `lead=#${mission.leadAgentId}` : "");
  }
});
setTimeout(() => process.exit(0), Number(seconds) * 1000);
