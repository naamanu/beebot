import WebSocket from "ws";

// One Reson8 "turns" session per live mic. The browser streams 16 kHz PCM to
// our server, and we relay it so the API key never reaches the browser.
// Docs: https://docs.reson8.dev/api/speech-to-text/turns/

export interface TurnHandlers {
  onInterim: (text: string) => void;
  onTurn: (text: string) => void;
  onError: (message: string) => void;
}

export class Reson8Turns {
  private ws: WebSocket;
  private latest = "";
  private pending: Buffer[] = [];

  constructor(apiKey: string, phrases: string[], private h: TurnHandlers) {
    const params = new URLSearchParams({
      encoding: "pcm_s16le",
      sample_rate: "16000",
      channels: "1",
      language: "en",
      filler_mode: "clean",
    });
    if (phrases.length) params.set("phrases", phrases.join(","));
    this.ws = new WebSocket(`wss://api.reson8.dev/v1/speech-to-text/turns?${params}`, {
      headers: { Authorization: `ApiKey ${apiKey}` },
    });
    this.ws.on("open", () => {
      for (const chunk of this.pending) this.ws.send(chunk);
      this.pending = [];
    });
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      const msg = JSON.parse(data.toString()) as { type: string; text?: string };
      if (msg.type === "turn_start") this.latest = "";
      if (msg.type === "turn_end_candidate" && msg.text !== undefined) {
        this.latest = msg.text;
        this.h.onInterim(msg.text);
      }
      if (msg.type === "turn_end") {
        const text = this.latest.trim();
        this.latest = "";
        if (text) this.h.onTurn(text);
      }
    });
    this.ws.on("unexpected-response", (_req, res) => {
      this.h.onError(`Reson8 rejected the connection (${res.statusCode}): ${res.headers["x-error-message"] ?? ""}`);
    });
    this.ws.on("close", (code, reason) => {
      if (code !== 1000 && code !== 1005) this.h.onError(`Reson8 closed (${code} ${reason.toString()})`);
    });
    this.ws.on("error", (err) => this.h.onError(`Reson8: ${err.message}`));
  }

  send(pcm: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(pcm);
    else if (this.ws.readyState === WebSocket.CONNECTING) this.pending.push(pcm);
  }

  // Flush whatever is mid-turn, then close once Reson8 confirms.
  close(): void {
    if (this.ws.readyState !== WebSocket.OPEN) {
      this.ws.terminate();
      return;
    }
    this.ws.send(JSON.stringify({ type: "flush_request" }));
    const timer = setTimeout(() => this.ws.close(1000), 1500);
    this.ws.once("close", () => clearTimeout(timer));
    this.ws.on("message", (data, isBinary) => {
      if (!isBinary && JSON.parse(data.toString()).type === "turn_end") this.ws.close(1000);
    });
  }
}
