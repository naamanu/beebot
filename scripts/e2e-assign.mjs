// Sends one utterance and prints what happens for a few seconds.
import { towerSocket } from "./tower-socket.mjs";
const [utterance, seconds = "12"] = process.argv.slice(2);
const connect = async () => { const w = await towerSocket(); return new Promise((res, rej) => { w.on("open", () => res(w)); w.on("error", rej); }); };
let ws;
for (let i = 0; i < 40 && !ws; i++) { try { ws = await connect(); } catch { await new Promise((r) => setTimeout(r, 250)); } }
if (!ws) throw new Error("Could not connect to Control Tower.");
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.type === "state") console.log("state:", m.agents.map((a) => `${a.id}:${a.status} "${a.task.slice(0, 50)}" (${a.events.length} events)`).join(" | ") || "no agents");
  if (m.type === "verdict") console.log("verdict:", m.verdict.target, m.verdict.intent, m.verdict.action, `${m.verdict.confidence * 100}%`);
  if (m.type === "agent_event") console.log(`  [${m.id}] ${m.event.kind}: ${m.event.text.slice(0, 100)}`);
  if (m.type === "notice") console.log("notice:", m.text);
});
if (utterance) ws.send(JSON.stringify({ type: "say", text: utterance }));
setTimeout(() => process.exit(0), Number(seconds) * 1000);
