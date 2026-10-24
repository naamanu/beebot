import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { startMic } from "../web/lib/mic.ts";

function browserAudio(t: TestContext, failModule = false) {
  let stopped = 0;
  let closed = 0;
  let resumed = 0;
  const restore: (() => void)[] = [];
  const stub = (object: object, key: PropertyKey, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    Object.defineProperty(object, key, { configurable: true, value });
    restore.push(() => { if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key); });
  };
  const source = { connect: () => {}, disconnect: () => {} };
  class Context {
    state = "suspended";
    audioWorklet = { addModule: async () => { if (failModule) throw new Error("worklet failed"); } };
    resume = async () => { resumed++; this.state = "running"; };
    close = async () => { closed++; };
    createMediaStreamSource = () => source;
  }
  class Worklet {
    port = { onmessage: null };
    disconnect = () => {};
  }
  stub(navigator, "mediaDevices", { getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stopped++; } }] }) });
  stub(globalThis, "AudioContext", Context);
  stub(globalThis, "AudioWorkletNode", Worklet);
  t.after(() => restore.reverse().forEach((reset) => reset()));
  return { stopped: () => stopped, closed: () => closed, resumed: () => resumed };
}

test("a suspended audio context is resumed before capturing microphone chunks", async (t) => {
  const audio = browserAudio(t);
  const stop = await startMic(() => {}, () => {});
  assert.equal(audio.resumed(), 1);
  stop();
  assert.equal(audio.stopped(), 1);
  assert.equal(audio.closed(), 1);
});

test("audio setup failure releases microphone access and its audio context", async (t) => {
  const audio = browserAudio(t, true);
  await assert.rejects(startMic(() => {}, () => {}), /worklet failed/);
  assert.equal(audio.stopped(), 1);
  assert.equal(audio.closed(), 1);
});
