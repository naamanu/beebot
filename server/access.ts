import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE = "control_tower_session";

// This is a local app. Only loopback hosts and explicitly named UI origins may
// bootstrap a session; cross-site pages cannot read or mint a control cookie.
export class ControlAccess {
  private token = randomBytes(32).toString("hex");
  private uiOrigins: Set<string>;

  constructor(uiOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"]) {
    this.uiOrigins = new Set(uiOrigins.map((origin) => new URL(origin).origin));
  }

  trusted(req: IncomingMessage): boolean {
    const port = req.socket.localPort;
    const origins = new Set([...this.uiOrigins, `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
    if (![...origins].some((origin) => new URL(origin).host === req.headers.host)) return false;
    if (req.headers["sec-fetch-site"] === "cross-site") return false;
    const origin = req.headers.origin;
    return !origin || origins.has(origin);
  }

  authenticated(req: IncomingMessage): boolean {
    if (!this.trusted(req)) return false;
    const cookie = req.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    if (!cookie || !/^[a-f0-9]{64}$/.test(cookie)) return false;
    return timingSafeEqual(Buffer.from(cookie), Buffer.from(this.token));
  }

  bootstrap(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.trusted(req) || req.method !== "POST" || req.headers["x-control-tower"] !== "session") return false;
    res.setHeader("set-cookie", `${COOKIE}=${this.token}; Path=/; HttpOnly; SameSite=Strict`);
    res.setHeader("cache-control", "no-store");
    return true;
  }
}
