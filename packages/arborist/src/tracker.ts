// Keeps the statuses of a running tree for a host that receives them as btlive does: the runtime
// tree once (RuntimeNode[]), then snapshots and changes by runtime UID. Feed its `statuses` to the
// viewer; it is replaced, never mutated, on every update.

import { mapRuntimeTree, type Mapping } from "./live_mapping.ts";
import type { TreeDef } from "./model.ts";
import type { RuntimeNode, StatusChange, StatusEntry } from "./protocol.ts";
import { derive, foldStatusChanges, NO_STATUSES, snapshotStatuses, type Statuses } from "./status.ts";

export class StatusTracker {
  private trees: Map<string, TreeDef>;
  /** The robot's main tree ID, once setRuntimeTree() was called. */
  treeId: string | undefined;
  runtime: RuntimeNode[] | undefined;
  /** How runtime UIDs pair up with tree nodes; mapping.mismatches says where they don't. */
  mapping: Mapping | undefined;
  statuses: Statuses = NO_STATUSES;

  constructor(trees: Iterable<TreeDef> = []) {
    this.trees = new Map([...trees].map((t) => [t.id, t]));
  }

  /** New versions of the trees (an edit, a reload): runtime nodes are paired up again. */
  setTrees(trees: Iterable<TreeDef>) {
    this.trees = new Map([...trees].map((t) => [t.id, t]));
    if (!this.treeId || !this.runtime) return;
    this.mapping = mapRuntimeTree(this.treeId, this.runtime, this.trees);
    this.statuses = { ...this.statuses, ...derive(this.statuses.statusByUid, this.mapping) };
  }

  /** The tree the robot runs (btlive "tree"); clears statuses. */
  setRuntimeTree(treeId: string, nodes: RuntimeNode[]) {
    this.treeId = treeId;
    this.runtime = nodes;
    this.mapping = mapRuntimeTree(treeId, nodes, this.trees);
    this.statuses = NO_STATUSES;
  }

  /** Every node's status at time `t` (btlive "snapshot"). */
  applySnapshot(statuses: StatusEntry[], t: number) {
    this.statuses = snapshotStatuses(statuses, t, this.mapping);
  }

  /** Status changes in time order (btlive "status"). */
  applyChanges(changes: StatusChange[]) {
    this.statuses = foldStatusChanges(this.statuses, changes, this.mapping, this.runtime?.[0]?.uid);
  }

  clear() {
    this.statuses = NO_STATUSES;
  }
}
