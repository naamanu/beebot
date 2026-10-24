import WebSocket from "ws";

// One Reson8 turns session per live mic. Audio is 16 kHz mono PCM16;
// authentication stays on the server.
export interface TurnHandlers {
  onReady?: () => void;
  onClose?: () => void;
  onTurnStart?: () => void;
  onInterim: (text: string) => void;
  onTurn: (text: string) => void;
  onError: (message: string) => void;
}

export class Reson8Turns {
  private ws: WebSocket;
  private latest = "";
  private pending: Buffer[] = [];
  private closing = false;
  private closed = false;
  private failed = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(apiKey: string, phrases: string[], private h: TurnHandlers, endpoint = "wss://api.reson8.dev/v1/speech-to-text/turns") {
    const url = new URL(endpoint);
    for (const [name, value] of Object.entries({ encoding: "pcm_s16le", sample_rate: "16000", channels: "1", language: "en", filler_mode: "clean" })) url.searchParams.set(name, value);
    if (phrases.length) url.searchParams.set("phrases", phrases.join(","));
    this.ws = new WebSocket(url, { headers: { Authorization: `ApiKey ${apiKey}` }, handshakeTimeout: 10_000 });
    this.ws.on("open", () => {
      if (this.failed || this.closed) return;
      for (const chunk of this.pending) this.ws.send(chunk);
      this.pending = [];
      this.h.onReady?.();
      if (this.closing) this.flush();
    });
    this.ws.on("message", (data, isBinary) => {
      if (isBinary || this.failed || this.closed) return;
      let msg: { type: string; text?: string };
      try {
        msg = JSON.parse(data.toString());
        if (!msg || typeof msg.type !== "string" || (msg.text !== undefined && typeof msg.text !== "string")) throw new Error("Invalid message");
      } catch { this.fail("The speech service sent an invalid response. Try speaking again."); return; }
      if (msg.type === "turn_start") {
        this.latest = "";
        this.h.onTurnStart?.();
      }
      if (msg.type === "turn_end_candidate" && msg.text !== undefined) {
        this.latest = msg.text;
        this.h.onInterim(msg.text);
      }
      if (msg.type === "turn_end") {
        const text = this.latest.trim();
        this.latest = "";
        if (text) this.h.onTurn(text);
        if (this.closing) this.ws.close(1000);
      }
    });
    this.ws.on("unexpected-response", (_req, res) => {
      res.resume();
      this.fail(`Speech connection rejected (${res.statusCode}): ${res.headers["x-error-message"] ?? res.statusMessage ?? "unknown reason"}`);
    });
    this.ws.on("close", (code, reason) => {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.flushTimer);
      this.pending = [];
      if (!this.failed && (!this.closing || (code !== 1000 && code !== 1005))) {
        this.failed = true;
        this.h.onError(`Speech connection ended (${code}${reason.length ? `: ${reason}` : ""}). Click Talk to reconnect.`);
      }
      this.h.onClose?.();
    });
    this.ws.on("error", (err: NodeJS.ErrnoException) => {
      const message = err.code === "ENOTFOUND" || err.code === "EAI_AGAIN"
        ? "Cannot reach the speech service: DNS lookup failed. Check the backend's network access, then try again."
        : `Speech connection failed: ${err.message}`;
      this.fail(message);
    });
  }

  send(pcm: Buffer): void {
    if (this.closing || this.closed || this.failed) return;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.pending.push(pcm);
  }

  // Releasing push-to-talk must wait for the handshake and queued audio,
  // then keep the socket alive long enough to receive the final transcript.
  close(): void {
    if (this.closing || this.closed || this.failed) return;
    this.closing = true;
    if (this.ws.readyState === WebSocket.OPEN) this.flush();
  }

  // A disconnected browser cannot receive a final transcript.
  abort(): void {
    if (this.closed) return;
    this.closing = true;
    this.failed = true;
    this.pending = [];
    clearTimeout(this.flushTimer);
    this.ws.terminate();
  }

  private flush(): void {
    this.ws.send(JSON.stringify({ type: "flush_request" }));
    this.flushTimer = setTimeout(() => this.ws.close(1000), 5000);
  }

  private fail(message: string): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    clearTimeout(this.flushTimer);
    this.pending = [];
    this.h.onError(message);
    this.ws.terminate();
  }
}
