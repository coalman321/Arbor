// Arbor backend -> frontend status of the robot connection, sent on the live relay socket only
// (src/server/live_relay.ts) alongside the robot's own btlive messages.

export interface RelayMsg {
  op: "relay";
  state: "connecting" | "connected" | "disconnected" | "error";
  url: string;
  message?: string;
}
