import WebSocket from "ws";

// CLI clients use the same local session boundary as the browser.
export async function towerSocket() {
  const base = process.env.CONTROL_TOWER_URL || "http://127.0.0.1:8787";
  const response = await fetch(new URL("/api/session", base), {
    method: "POST",
    headers: { "x-control-tower": "session" },
  });
  if (!response.ok) throw new Error(`Control session failed (${response.status})`);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("The server did not issue a control session cookie.");
  const url = new URL("/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url, { headers: { Cookie: cookie } });
}
