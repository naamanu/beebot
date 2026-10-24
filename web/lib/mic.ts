// Streams microphone audio as 16 kHz PCM16 chunks.
export async function startMic(onChunk: (pcm: ArrayBuffer) => void, onLevel: (level: number) => void) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.audioWorklet.addModule("/pcm-worklet.js");
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-worklet");
  node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    const samples = new Int16Array(e.data);
    let peak = 0;
    for (let i = 0; i < samples.length; i += 8) peak = Math.max(peak, Math.abs(samples[i]!));
    onLevel(peak / 0x8000);
    onChunk(e.data);
  };
  source.connect(node);
  return () => {
    node.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
}
