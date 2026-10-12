// Node statuses as the viewer shows them. A host reports what the robot's nodes are doing, keyed by
// runtime UID (btlive messages, a log file, NetworkTables, ...); these fold that into what each
// node of the trees shows, via the Mapping from mapRuntimeTree().

import type { Mapping } from "./live_mapping.ts";
import type { NodeStatus, StatusChange, StatusEntry } from "./protocol.ts";

export interface StatusInfo {
  status: NodeStatus;
  /** Most recent non-IDLE status, shown faded after BT.CPP resets the node to IDLE. */
  last: NodeStatus;
  t: number;
  /**
   * IDLE, but `last` is a result (SUCCESS/FAILURE/SKIPPED) from the tree's current run. BT.CPP resets
   * every node to IDLE as soon as the whole tree finishes; these keep showing that run's results
   * until the next run starts, rather than the whole tree fading at once.
   */
  done?: boolean;
}

export const FINISHED: ReadonlySet<NodeStatus> = new Set(["SUCCESS", "FAILURE", "SKIPPED"]);

/** CSS class for a node's live status: "is-*" for what it's doing (or just did), "was-*" for older results. */
export function statusClass(info: StatusInfo | undefined): string {
  if (!info) return "";
  if (info.status !== "IDLE") return `is-${info.status.toLowerCase()}`;
  return `${info.done ? "is" : "was"}-${info.last.toLowerCase()}`;
}

/** What the viewer draws: statuses by runtime UID, and the same mapped onto tree nodes. */
export interface Statuses {
  statusByUid: Record<number, StatusInfo>;
  /** Keyed by instance path within the robot's main tree. */
  statusByPath: Record<string, StatusInfo>;
  /** Keyed by "<treeId>:<nodeUid>": the latest status of any instance of that node. */
  statusByDef: Record<string, StatusInfo>;
  /** When the robot's root last started running, for StatusInfo.done. */
  runStart?: number;
}

export const NO_STATUSES: Statuses = { statusByUid: {}, statusByPath: {}, statusByDef: {} };

/** Key of Statuses.statusByDef. */
export function defKey(treeId: string, nodeUid: string): string {
  return `${treeId}:${nodeUid}`;
}

/** Maps statuses by runtime UID onto tree nodes. */
export function derive(statusByUid: Record<number, StatusInfo>, mapping: Mapping | undefined) {
  const statusByPath: Record<string, StatusInfo> = {};
  const statusByDef: Record<string, StatusInfo> = {};
  if (mapping) {
    for (const [uid, info] of Object.entries(statusByUid)) {
      const m = mapping.byRuntimeUid.get(Number(uid));
      if (!m) continue;
      statusByPath[m.path] = info;
      const key = defKey(m.treeId, m.nodeUid);
      if (!statusByDef[key] || statusByDef[key].t < info.t) statusByDef[key] = info;
    }
  }
  return { statusByPath, statusByDef };
}

/** Statuses from a full snapshot (btlive "snapshot"): every listed node's status at time `t`. */
export function snapshotStatuses(statuses: StatusEntry[], t: number, mapping: Mapping | undefined): Statuses {
  const statusByUid: Record<number, StatusInfo> = {};
  for (const [uid, status] of statuses) statusByUid[uid] = { status, last: status, t };
  return { statusByUid, ...derive(statusByUid, mapping) };
}

/**
 * Applies status changes (btlive "status") to `prev`, returning new Statuses. `rootUid` is the
 * runtime UID of the main tree's root: when it starts running, the previous run's results fade.
 */
export function foldStatusChanges(prev: Statuses, changes: StatusChange[], mapping: Mapping | undefined, rootUid: number | undefined): Statuses {
  let statusByUid = { ...prev.statusByUid };
  const statusByPath = { ...prev.statusByPath };
  const statusByDef = { ...prev.statusByDef };
  let runStart = prev.runStart;
  let restarted = false;
  for (const [t, uid, before, status] of changes) {
    if (uid === rootUid && status === "RUNNING" && before !== "RUNNING") {
      // A new run: the previous run's results fade.
      runStart = t;
      restarted = true;
      statusByUid = Object.fromEntries(Object.entries(statusByUid).map(([k, v]) => [k, v.done ? { ...v, done: false } : v]));
    }
    const old = statusByUid[uid];
    const info: StatusInfo = { status, last: status === "IDLE" ? (old?.last ?? before) : status, t };
    // Reset to IDLE after finishing in this run (a node halted while RUNNING still fades).
    if (status === "IDLE" && FINISHED.has(before) && (runStart === undefined || (old?.t ?? t) >= runStart)) info.done = true;
    statusByUid[uid] = info;
    const m = mapping?.byRuntimeUid.get(uid);
    if (m) {
      statusByPath[m.path] = info;
      statusByDef[defKey(m.treeId, m.nodeUid)] = info;
    }
  }
  return { statusByUid, ...(restarted ? derive(statusByUid, mapping) : { statusByPath, statusByDef }), runStart };
}

/**
 * A node's status. `liveMain`: the node is drawn as part of the robot's main tree, so its own
 * instance's status is known; otherwise (another tree on screen) the latest of any instance.
 */
export function nodeStatus(s: Statuses, path: string, treeId: string, nodeUid: string, liveMain: boolean): StatusInfo | undefined {
  return liveMain ? s.statusByPath[path] : s.statusByDef[defKey(treeId, nodeUid)];
}
