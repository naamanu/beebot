// End-to-end speech check: macOS `say` → Reson8 turns → transcript. No coding agents involved.
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reson8Turns } from "../server/reson8.ts";

const phrase = process.argv[2] ?? "Agent two, stop. You're editing the wrong file.";
const wav = join(mkdtempSync(join(tmpdir(), "tower-")), "say.wav");
execFileSync("say", ["-o", wav, "--data-format=LEI16@16000", "--file-format=WAVE", phrase]);
const pcm = readFileSync(wav).subarray(44); // strip WAV header

const started = Date.now();
const r = new Reson8Turns(process.env.RESON8_API_KEY!, ["agent two"], {
  onInterim: (t) => console.log(`  interim: ${t}`),
  onTurn: (t) => {
    console.log(`TURN (${Date.now() - started}ms): ${t}`);
    process.exit(0);
  },
  onError: (e) => console.log(`ERROR: ${e}`),
});
// Stream in real time (100 ms chunks), then a second of silence for end-of-turn detection.
const chunk = 3200;
const audio = Buffer.concat([pcm, Buffer.alloc(32000)]);
for (let i = 0; i < audio.length; i += chunk) {
  r.send(audio.subarray(i, i + chunk));
  await new Promise((res) => setTimeout(res, 100));
}
setTimeout(() => r.close(), 500);
setTimeout(() => (console.log("no turn received"), process.exit(1)), 6000);
