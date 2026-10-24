// Streams microphone audio as 16 kHz PCM16 chunks.
export async function startMic(onChunk: (pcm: ArrayBuffer) => void, onLevel: (level: number) => void) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access requires a supported browser on localhost or HTTPS.");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  let ctx: AudioContext | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let node: AudioWorkletNode | undefined;
  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false;
    if (node) node.port.onmessage = null;
    node?.disconnect();
    source?.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    if (ctx && ctx.state !== "closed") void ctx.close().catch(() => {});
  };
  try {
    ctx = new AudioContext({ sampleRate: 16000 });
    if (ctx.state === "suspended") await ctx.resume();
    await ctx.audioWorklet.addModule("/pcm-worklet.js");
    source = ctx.createMediaStreamSource(stream);
    node = new AudioWorkletNode(ctx, "pcm-worklet");
    node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (!active) return;
      const samples = new Int16Array(event.data);
      let peak = 0;
      for (let i = 0; i < samples.length; i += 8) peak = Math.max(peak, Math.abs(samples[i]!));
      onLevel(peak / 0x8000);
      onChunk(event.data);
    };
    source.connect(node);
    return cleanup;
  } catch (error) {
    cleanup();
    throw error;
  }
}
