// "btlive" v1: JSON-over-WebSocket protocol between a robot running BehaviorTree.CPP and the editor.
// docs/live_protocol.md is the normative description; keep the two in sync.

export const LIVE_PROTOCOL = "btlive";
export const LIVE_PROTOCOL_VERSION = 1;

export type NodeStatus = "IDLE" | "RUNNING" | "SUCCESS" | "FAILURE" | "SKIPPED";

/** One node of the tree instantiated on the robot, in depth-first pre-order (BT::Tree::applyVisitor). */
export interface RuntimeNode {
  /** BT::TreeNode::UID(); stable for the lifetime of the tree. */
  uid: number;
  /** Parent UID, or null for the root of the main tree. */
  parent: number | null;
  /** Registration ID, e.g. "Sequence", "MoveBase", "SubTree". */
  type: string;
  /** Instance name (the XML name attribute, or the registration ID if unset). */
  name: string;
  category?: "Action" | "Condition" | "Control" | "Decorator" | "SubTree";
  /** BT::TreeNode::fullPath(), e.g. "MainTree::0/pick::3/MoveArm". */
  path?: string;
  /** For SubTree nodes: the ID of the tree it instantiates. */
  subtree?: string;
}

// robot -> editor

export interface HelloMsg {
  op: "hello";
  protocol: typeof LIVE_PROTOCOL;
  version: number;
  robot?: string;
}

export interface TreeMsg {
  op: "tree";
  /** Increments every time the robot starts executing a different tree instance. */
  session: number;
  /** ID of the main tree. */
  tree_id: string;
  nodes: RuntimeNode[];
  /** The tree as loaded by the robot (BT::WriteTreeToXML), so a mismatch can be inspected. */
  xml?: string;
}

/** [uid, status] */
export type StatusEntry = [number, NodeStatus];

export interface SnapshotMsg {
  op: "snapshot";
  session: number;
  /** Milliseconds since the Unix epoch, robot clock. */
  t: number;
  statuses: StatusEntry[];
}

/** [t (ms since epoch), uid, previous status, new status] */
export type StatusChange = [number, number, NodeStatus, NodeStatus];

export interface StatusMsg {
  op: "status";
  session: number;
  changes: StatusChange[];
}

export interface BlackboardEntry {
  type: string;
  /** JSON value if the type is convertible (BT::JsonExporter), else a string or null. */
  value: unknown;
}

export interface BlackboardMsg {
  op: "blackboard";
  request_id?: number;
  session: number;
  blackboards: { path: string; tree_id: string; entries: Record<string, BlackboardEntry> }[];
}

export interface ErrorMsg {
  op: "error";
  message: string;
  request_id?: number;
}

export type RobotMessage = HelloMsg | TreeMsg | SnapshotMsg | StatusMsg | BlackboardMsg | ErrorMsg;

// editor -> robot

export type ClientMessage =
  | { op: "get_tree" }
  | { op: "get_snapshot" }
  | { op: "get_blackboard"; request_id?: number };

// editor backend -> editor frontend, on the relay socket only

export interface RelayMsg {
  op: "relay";
  state: "connecting" | "connected" | "disconnected" | "error";
  url: string;
  message?: string;
}

export const STATUS_VALUES: readonly NodeStatus[] = ["IDLE", "RUNNING", "SUCCESS", "FAILURE", "SKIPPED"];
