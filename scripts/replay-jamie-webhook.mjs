import "dotenv/config";
import { readFile } from "node:fs/promises";

const args = process.argv.slice(2);
if (args.some((arg) => !["--send", "--dry-run"].includes(arg)) || (args.includes("--send") && args.includes("--dry-run"))) {
  throw new Error("Usage: node scripts/replay-jamie-webhook.mjs [--dry-run | --send]");
}

const file = new URL("../demo/jamie-meeting.completed.json", import.meta.url);
const payload = JSON.parse(await readFile(file, "utf8"));
const pending = payload.data.tasks.filter((task) => !task.completed);

console.log(payload.data.title);
console.log(`${payload.data.transcript.length} transcript turns; ${payload.data.tasks.length - pending.length} completed items; ${pending.length} proposed follow-ups.`);

if (!args.includes("--send")) {
  console.log("Dry run: no request sent. Open an incident, then use --send to POST this fixture to http://127.0.0.1:8787/webhooks/jamie.");
} else {
  const secret = process.env.JAMIE_WEBHOOK_KEY;
  if (!secret) throw new Error("Set JAMIE_WEBHOOK_KEY in .env and restart the backend before sending. JAMIE_API_KEY is not required for this local fixture.");
  const response = await fetch("http://127.0.0.1:8787/webhooks/jamie", {
    method: "POST",
    headers: { "content-type": "application/json", "x-jamie-api-key": secret },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Jamie webhook failed (${response.status}): ${body}`);
  console.log(`Local webhook response (${response.status}): ${body}`);
  console.log("With an incident still loaded, the tower attaches the notes and offers three follow-ups. Agents start only if you accept the proposal. The current endpoint also returns OK when no incident is loaded; verify the proposal in the UI.");
}
