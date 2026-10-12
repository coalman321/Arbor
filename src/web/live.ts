// Client side of the live view: talks btlive (docs/live_protocol.md) to the robot through the
// backend's relay socket and folds status changes into the store.

import {
  derive,
  foldStatusChanges,
  mapRuntimeTree,
  snapshotStatuses,
  type ClientMessage,
  type Mapping,
  type RobotMessage,
} from "@coalman321/arborist";
import type { RelayMsg } from "../shared/relay.ts";
import { wsUrl } from "./api.ts";
import { closeReplay } from "./replay.ts";
import { initialLive, localStorageSet, openTree, toast, useStore, type LiveState, type LogEntry } from "./store.ts";

const LOG_LIMIT = 2000;

let socket: WebSocket | null = null;
let requestId = 0;
let bbTimer: number | null = null;

const get = useStore.getState;
const setLive = (patch: Partial<LiveState>) => useStore.setState({ live: { ...get().live, ...patch } });

export function connectLive(url: string) {
  disconnectLive();
  if (get().replay) closeReplay();
  localStorageSet(`bt-editor.liveUrl.${get().root}`, url);
  useStore.setState({ live: { ...initialLive(url), state: "connecting" } });
  const ws = new WebSocket(wsUrl(`/api/live?url=${encodeURIComponent(url)}`));
  socket = ws;
  ws.onmessage = (ev) => {
    if (socket !== ws) return;
    let msg: RobotMessage | RelayMsg;
    try {
      msg = JSON.parse(ev.data as string);
    } catch {
      return;
    }
    handle(msg);
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    setLive({ state: "error", message: "Lost connection to the editor backend" });
  };
}

export function disconnectLive() {
  const ws = socket;
  socket = null;
  ws?.close();
  if (bbTimer !== null) clearInterval(bbTimer);
  bbTimer = null;
  setLive({ state: "idle", message: undefined });
}

function send(msg: ClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

export function requestBlackboard() {
  send({ op: "get_blackboard", request_id: ++requestId });
}

export function setBlackboardPolling(on: boolean) {
  if (bbTimer !== null) clearInterval(bbTimer);
  bbTimer = on ? window.setInterval(requestBlackboard, 1000) : null;
  if (on) requestBlackboard();
}

export function setPaused(paused: boolean) {
  setLive({ paused });
  if (!paused) send({ op: "get_snapshot" });
}

function handle(msg: RobotMessage | RelayMsg) {
  const live = get().live;
  switch (msg.op) {
    case "relay":
      if (msg.state === "connected") setLive({ state: "connected", message: undefined });
      else setLive({ state: msg.state, message: msg.message });
      return;
    case "hello":
      if (msg.protocol !== "btlive" || msg.version !== 1) {
        toast(`Robot speaks ${msg.protocol} v${msg.version}; this editor expects btlive v1`, "error");
      }
      setLive({ robot: msg.robot });
      return;
    case "tree": {
      const mapping = computeMapping(msg.tree_id, msg.nodes);
      setLive({
        session: msg.session,
        treeId: msg.tree_id,
        runtime: msg.nodes,
        robotXml: msg.xml,
        mapping,
        statusByUid: {},
        statusByPath: {},
        statusByDef: {},
        log: [],
        runStart: undefined,
      });
      if (get().trees[msg.tree_id]) openTree(msg.tree_id);
      return;
    }
    case "snapshot": {
      if (msg.session !== live.session || live.paused) return;
      setLive({ ...snapshotStatuses(msg.statuses, msg.t, live.mapping), runStart: undefined });
      return;
    }
    case "status": {
      if (msg.session !== live.session || live.paused) return;
      const statuses = foldStatusChanges(live, msg.changes, live.mapping, live.runtime?.[0]?.uid);
      const entries: LogEntry[] = msg.changes.map(([t, uid, prev, status]) => ({ t, uid, prev, status }));
      const log = live.log.length + entries.length > LOG_LIMIT ? [...live.log, ...entries].slice(-LOG_LIMIT) : [...live.log, ...entries];
      setLive({ ...statuses, log });
      return;
    }
    case "blackboard":
      setLive({ blackboard: msg });
      return;
    case "error":
      toast(`Robot: ${msg.message}`, "error");
      return;
  }
}

export function computeMapping(treeId: string, nodes: NonNullable<LiveState["runtime"]>): Mapping {
  return mapRuntimeTree(treeId, nodes, new Map(Object.entries(get().trees)));
}

// Editing a tree while live changes its node uids/structure: re-pair the robot's nodes.
let remapTimer: number | null = null;
useStore.subscribe((s, prev) => {
  if (s.trees === prev.trees || !s.live.runtime || !s.live.treeId) return;
  if (remapTimer !== null) clearTimeout(remapTimer);
  remapTimer = window.setTimeout(() => {
    const live = get().live;
    if (!live.runtime || !live.treeId) return;
    const mapping = computeMapping(live.treeId, live.runtime);
    setLive({ mapping, ...derive(live.statusByUid, mapping) });
  }, 200);
});
