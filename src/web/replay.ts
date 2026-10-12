// Plays back a BehaviorTree.CPP .btlog: statuses at any moment of the log are fed into the same
// live state the robot connection uses, so the canvas colors nodes exactly as it does live.

import { BtLogError, parseBtlog, STATUS_BY_CODE, type BtLog } from "../shared/btlog.ts";
import { derive, FINISHED, type NodeStatus, type StatusInfo } from "@coalman321/arborist";
import { computeMapping, disconnectLive } from "./live.ts";
import { initialLive, openTree, toast, useStore, type LogEntry } from "./store.ts";

/** Transitions between saved snapshots of every node's status, for fast seeking. */
const CHECKPOINT_EVERY = 256;
const LOG_ROWS = 400;
export const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4, 10] as const;

export interface ReplayState {
  name: string;
  /** Total length, ms. */
  duration: number;
  /** Current playback position, ms since the first transition. */
  t: number;
  /** Number of transitions applied at `t`. */
  index: number;
  count: number;
  playing: boolean;
  speed: number;
  startMs: number;
  /** Times (ms) when the root finished, for markers on the timeline. */
  marks: { t: number; status: NodeStatus }[];
}

interface Loaded {
  log: BtLog;
  /** Dense index of each uid in the node arrays. */
  slot: Map<number, number>;
  /** checkpoints[k] = statuses after k * CHECKPOINT_EVERY transitions. */
  checkpoints: Snapshot[];
  /** Indexes of the transitions where the root started running, i.e. where each run began. */
  runStarts: number[];
}

/** Every node's status, last non-IDLE status, and the times of its latest transition and latest result. */
interface Snapshot {
  status: Uint8Array;
  last: Uint8Array;
  t: Float64Array;
  lastT: Float64Array;
}

function apply(snap: Snapshot, s: number, status: number, t: number) {
  snap.status[s] = status;
  if (status !== 0) {
    snap.last[s] = status;
    snap.lastT[s] = t;
  }
  snap.t[s] = t;
}

let loaded: Loaded | null = null;
let raf: number | null = null;

const get = useStore.getState;
const setReplay = (patch: Partial<ReplayState>) => {
  const r = get().replay;
  if (r) useStore.setState({ replay: { ...r, ...patch } });
};

export async function openLogFile(file: File) {
  let log: BtLog;
  try {
    log = parseBtlog(await file.arrayBuffer());
  } catch (e) {
    toast(e instanceof BtLogError ? `${file.name}: ${e.message}` : `Couldn't read ${file.name}: ${(e as Error).message}`, "error");
    return;
  }
  startReplay(file.name, log);
}

export function startReplay(name: string, log: BtLog) {
  stopTimer();
  if (get().live.state !== "idle" && get().live.state !== "replay") disconnectLive();

  const slot = new Map(log.nodes.map((n, i) => [n.uid, i]));
  // Snapshots of every node's status (and last non-IDLE status) as the log goes on.
  const n = log.nodes.length;
  const cur: Snapshot = { status: new Uint8Array(n), last: new Uint8Array(n), t: new Float64Array(n), lastT: new Float64Array(n) };
  const copy = (x: Snapshot): Snapshot => ({ status: x.status.slice(), last: x.last.slice(), t: x.t.slice(), lastT: x.lastT.slice() });
  const checkpoints: Snapshot[] = [];
  const rootUid = log.nodes[0]?.uid;
  const marks: ReplayState["marks"] = [];
  const runStarts: number[] = [];
  for (let i = 0; i <= log.times.length; i++) {
    if (i % CHECKPOINT_EVERY === 0) checkpoints.push(copy(cur));
    if (i === log.times.length) break;
    const s = slot.get(log.uids[i]);
    if (s === undefined) continue;
    const st = log.statuses[i];
    if (log.uids[i] === rootUid) {
      if (st === 1 && cur.status[s] !== 1) runStarts.push(i);
      if (st === 2 || st === 3) marks.push({ t: log.times[i], status: STATUS_BY_CODE[st] });
    }
    apply(cur, s, st, log.times[i]);
  }
  loaded = { log, slot, checkpoints, runStarts };

  const mapping = computeMapping(log.treeId, log.nodes);
  useStore.setState({
    live: { ...initialLive(get().live.url), state: "replay", treeId: log.treeId, runtime: log.nodes, robotXml: log.xml, mapping, robot: name },
    replay: {
      name,
      duration: log.times.length ? log.times[log.times.length - 1] : 0,
      t: 0,
      index: 0,
      count: log.times.length,
      playing: false,
      speed: 1,
      startMs: log.startMs,
      marks,
    },
  });
  if (get().trees[log.treeId]) openTree(log.treeId);
  seek(0);
  if (mapping.byRuntimeUid.size === 0) {
    toast(`This log ran "${log.treeId}", which isn't in this project. Open the project it came from to see it.`, "error");
  } else play();
}

export function closeReplay() {
  stopTimer();
  loaded = null;
  useStore.setState({ replay: null, live: initialLive(get().live.url) });
}

// A log belongs to the project it was opened in: close it when another project is opened.
useStore.subscribe((s, prev) => {
  if (s.replay && s.root !== prev.root) closeReplay();
});

/** Number of transitions with time <= t. */
function indexAt(t: number): number {
  return upperBound(loaded!.log.times, t);
}

/** Number of leading elements of sorted `xs` that are <= x. */
function upperBound(xs: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Shows the tree as it was at time `t` (ms since the first transition). */
export function seek(t: number) {
  const r = get().replay;
  if (!loaded || !r) return;
  t = Math.max(0, Math.min(t, r.duration));
  const index = indexAt(t);
  const { log, slot, checkpoints, runStarts } = loaded;
  const cp = checkpoints[Math.floor(index / CHECKPOINT_EVERY)];
  const snap: Snapshot = { status: cp.status.slice(), last: cp.last.slice(), t: cp.t.slice(), lastT: cp.lastT.slice() };
  for (let i = Math.floor(index / CHECKPOINT_EVERY) * CHECKPOINT_EVERY; i < index; i++) {
    const s = slot.get(log.uids[i]);
    if (s !== undefined) apply(snap, s, log.statuses[i], log.times[i]);
  }
  // When the current run began; results since then stay solid after BT.CPP resets them to IDLE.
  const run = runStarts[upperBound(runStarts, index - 1) - 1];
  const runStart = run === undefined ? -Infinity : log.times[run];
  const statusByUid: Record<number, StatusInfo> = {};
  log.nodes.forEach((node, s) => {
    // Nodes that haven't run yet show no status at all.
    if (snap.status[s] === 0 && snap.last[s] === 0) return;
    const info: StatusInfo = { status: STATUS_BY_CODE[snap.status[s]], last: STATUS_BY_CODE[snap.last[s]], t: log.startMs + snap.t[s] };
    if (info.status === "IDLE" && FINISHED.has(info.last) && snap.lastT[s] >= runStart) info.done = true;
    statusByUid[node.uid] = info;
  });
  const entries: LogEntry[] = [];
  const prevOf = new Map<number, NodeStatus>();
  const from = Math.max(0, index - LOG_ROWS);
  // "prev" for the first rows shown: the status before them, from the snapshot at `from`.
  for (let i = from; i < index; i++) {
    const uid = log.uids[i];
    const st = STATUS_BY_CODE[log.statuses[i]];
    entries.push({ t: log.startMs + log.times[i], uid, prev: prevOf.get(uid) ?? statusBefore(i, uid), status: st });
    prevOf.set(uid, st);
  }
  const live = get().live;
  useStore.setState({
    live: { ...live, statusByUid, ...derive(statusByUid, live.mapping), log: entries },
    replay: { ...r, t, index },
  });
}

function statusBefore(i: number, uid: number): NodeStatus {
  const { log } = loaded!;
  for (let j = i - 1; j >= 0 && j >= i - 5000; j--) if (log.uids[j] === uid) return STATUS_BY_CODE[log.statuses[j]];
  return "IDLE";
}

export function play() {
  const r = get().replay;
  if (!r) return;
  if (r.t >= r.duration) seek(0);
  setReplay({ playing: true });
  let prev = performance.now();
  const frame = (now: number) => {
    const cur = get().replay;
    if (!cur?.playing) return;
    const t = cur.t + (now - prev) * cur.speed;
    prev = now;
    if (t >= cur.duration) {
      seek(cur.duration);
      setReplay({ playing: false });
      raf = null;
      return;
    }
    // Only redraw when the tree actually changes.
    if (indexAt(t) !== cur.index) seek(t);
    else setReplay({ t });
    raf = requestAnimationFrame(frame);
  };
  stopTimer();
  raf = requestAnimationFrame(frame);
}

export function pause() {
  stopTimer();
  setReplay({ playing: false });
}

function stopTimer() {
  if (raf !== null) cancelAnimationFrame(raf);
  raf = null;
}

export function togglePlay() {
  if (get().replay?.playing) pause();
  else play();
}

/** Jumps to the previous (-1) or next (+1) moment something changed. */
export function step(dir: 1 | -1) {
  const r = get().replay;
  if (!loaded || !r) return;
  pause();
  const times = loaded.log.times;
  if (dir > 0) {
    if (r.index < times.length) seek(times[r.index]);
  } else if (r.index > 0) {
    // Undo the latest group of changes (all those at one timestamp): show the group before it.
    let start = r.index - 1;
    while (start > 0 && times[start - 1] === times[r.index - 1]) start--;
    seek(start > 0 ? times[start - 1] : 0);
  }
}

export function setSpeed(speed: number) {
  setReplay({ speed });
}
