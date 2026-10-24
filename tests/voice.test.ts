import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import { Reson8Turns } from "../server/reson8.ts";

async function until(read: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!read() && Date.now() < deadline) await delay(10);
  assert.ok(read(), "Expected speech event did not arrive");
}

test("releasing push-to-talk while connecting still sends the audio and final transcript", async (t) => {
  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => { setTimeout(() => wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req)), 50); });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const audio: Buffer[] = [];
  wss.on("connection", (ws) => {
    ws.on("message", (raw, binary) => {
      if (binary) audio.push(Buffer.from(raw as Buffer));
      else if (JSON.parse(raw.toString()).type === "flush_request") {
        ws.send(JSON.stringify({ type: "turn_start" }));
        ws.send(JSON.stringify({ type: "turn_end_candidate", text: "A voice test" }));
        ws.send(JSON.stringify({ type: "turn_end" }));
      }
    });
  });
  const turns: string[] = [];
  const errors: string[] = [];
  const voice = new Reson8Turns("test", [], { onInterim: () => {}, onTurn: text => turns.push(text), onError: error => errors.push(error) }, `ws://127.0.0.1:${address.port}`);
  t.after(async () => { for (const ws of wss.clients) ws.terminate(); wss.close(); http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); });
  const pcm = Buffer.from([1, 2, 3, 4]);
  voice.send(pcm);
  voice.close();
  await until(() => turns.length === 1 || errors.length > 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(turns, ["A voice test"]);
  assert.deepEqual(audio, [pcm]);
});

test("a rejected speech connection reports one error and closes its session", async (t) => {
  const http = createServer();
  http.on("upgrade", (_req, socket) => { socket.end("HTTP/1.1 401 Unauthorized\r\nX-Error-Message: Invalid API key\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert.ok(address && typeof address === "object");
  const errors: string[] = [];
  let closed = false;
  new Reson8Turns("test", [], { onInterim: () => {}, onTurn: () => {}, onError: error => errors.push(error), onClose: () => { closed = true; } }, `ws://127.0.0.1:${address.port}`);
  t.after(async () => { http.closeAllConnections(); await new Promise<void>(done => http.close(() => done())); });
  await until(() => closed);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /401.*Invalid API key/);
});
