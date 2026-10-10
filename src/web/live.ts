// Client side of the live view: talks btlive (docs/live_protocol.md) to the robot through the
// backend's relay socket and folds status changes into the store.

import { mapRuntimeTree, type Mapping } from "../shared/live_mapping.ts";
import type { ClientMessage, RelayMsg, RobotMessage } from "../shared/protocol.ts";
import { wsUrl } from "./api.ts";
import { closeReplay } from "./replay.ts";
import { FINISHED, initialLive, localStorageSet, openTree, toast, useStore, type LiveState, type LogEntry, type StatusInfo } from "./store.ts";

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
      const statusByUid: Record<number, StatusInfo> = {};
      for (const [uid, status] of msg.statuses) statusByUid[uid] = { status, last: status, t: msg.t };
      setLive({ statusByUid, ...derive(statusByUid, live.mapping), runStart: undefined });
      return;
    }
    case "status": {
      if (msg.session !== live.session || live.paused) return;
      let statusByUid = { ...live.statusByUid };
      const statusByPath = { ...live.statusByPath };
      const statusByDef = { ...live.statusByDef };
      const entries: LogEntry[] = [];
      const rootUid = live.runtime?.[0]?.uid;
      let runStart = live.runStart;
      let restarted = false;
      for (const [t, uid, prev, status] of msg.changes) {
        if (uid === rootUid && status === "RUNNING" && prev !== "RUNNING") {
          // A new run: the previous run's results fade.
          runStart = t;
          restarted = true;
          statusByUid = Object.fromEntries(Object.entries(statusByUid).map(([k, v]) => [k, v.done ? { ...v, done: false } : v]));
        }
        const old = statusByUid[uid];
        const info: StatusInfo = { status, last: status === "IDLE" ? (old?.last ?? prev) : status, t };
        // Reset to IDLE after finishing in this run (a node halted while RUNNING still fades).
        if (status === "IDLE" && FINISHED.has(prev) && (runStart === undefined || (old?.t ?? t) >= runStart)) info.done = true;
        statusByUid[uid] = info;
        const m = live.mapping?.byRuntimeUid.get(uid);
        if (m) {
          statusByPath[m.path] = info;
          statusByDef[`${m.treeId}:${m.nodeUid}`] = info;
        }
        entries.push({ t, uid, prev, status });
      }
      const log = live.log.length + entries.length > LOG_LIMIT ? [...live.log, ...entries].slice(-LOG_LIMIT) : [...live.log, ...entries];
      setLive({ statusByUid, ...(restarted ? derive(statusByUid, live.mapping) : { statusByPath, statusByDef }), log, runStart });
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

export function derive(statusByUid: Record<number, StatusInfo>, mapping: Mapping | undefined) {
  const statusByPath: Record<string, StatusInfo> = {};
  const statusByDef: Record<string, StatusInfo> = {};
  if (mapping) {
    for (const [uid, info] of Object.entries(statusByUid)) {
      const m = mapping.byRuntimeUid.get(Number(uid));
      if (!m) continue;
      statusByPath[m.path] = info;
      const key = `${m.treeId}:${m.nodeUid}`;
      if (!statusByDef[key] || statusByDef[key].t < info.t) statusByDef[key] = info;
    }
  }
  return { statusByPath, statusByDef };
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
