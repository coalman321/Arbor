// Relays one browser WebSocket to one robot WebSocket. The backend does the connecting so the
// robot only has to be reachable from the machine running the editor, not from the browser.

import WebSocket from "ws";
import type { RelayMsg } from "../shared/relay.ts";

const RECONNECT_MS = 2000;

export function relayToRobot(browser: WebSocket, url: string) {
  let robot: WebSocket | null = null;
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  let lastState: RelayMsg["state"] | null = null;

  const report = (state: RelayMsg["state"], message?: string) => {
    // Don't flood the browser with "connecting"/"error" every retry while the robot is down.
    if (state === lastState && state !== "connected") return;
    lastState = state;
    const msg: RelayMsg = { op: "relay", state, url, ...(message ? { message } : {}) };
    if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(msg));
  };

  const connect = () => {
    if (closed) return;
    report("connecting");
    const ws = new WebSocket(url, { handshakeTimeout: 5000 });
    robot = ws;
    ws.on("open", () => report("connected"));
    ws.on("message", (data, isBinary) => {
      if (!isBinary && browser.readyState === WebSocket.OPEN) browser.send(data.toString());
    });
    ws.on("error", (err) => report("error", err.message));
    ws.on("close", () => {
      if (robot !== ws) return;
      robot = null;
      if (closed) return;
      report("disconnected", `retrying in ${RECONNECT_MS / 1000}s`);
      timer = setTimeout(connect, RECONNECT_MS);
    });
  };

  browser.on("message", (data) => {
    if (robot?.readyState === WebSocket.OPEN) robot.send(data.toString());
  });
  browser.on("close", () => {
    closed = true;
    if (timer) clearTimeout(timer);
    robot?.close();
  });

  connect();
}
