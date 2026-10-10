// Maps the node UIDs the robot reports to nodes of the project's trees.
//
// The robot sends its tree in depth-first pre-order with SubTrees expanded; we walk the editor's
// trees the same way, expanding <SubTree ID="X"/> into tree X, and pair nodes up positionally.
// Each editor node instance is identified by an "instance path": the uids of the SubTree nodes
// leading to it plus its own uid, joined with "/". A node of the main tree is "n4"; node n2 of a
// subtree instantiated by SubTree node n4 is "n4/n2".

import type { BTNode, TreeDef } from "./model.ts";
import type { RuntimeNode } from "./protocol.ts";

export interface MappedNode {
  /** Instance path relative to the main tree. */
  path: string;
  /** Tree that defines the node, and the node's uid in it. */
  treeId: string;
  nodeUid: string;
}

export interface Mapping {
  byRuntimeUid: Map<number, MappedNode>;
  /** Human-readable reasons nodes couldn't be paired. Empty when the trees match exactly. */
  mismatches: string[];
  /** Runtime nodes that have no editor counterpart. */
  unmatched: number;
}

export function joinPath(prefix: string, uid: string): string {
  return prefix ? `${prefix}/${uid}` : uid;
}

export function mapRuntimeTree(mainTreeId: string, runtime: RuntimeNode[], trees: Map<string, TreeDef>): Mapping {
  const children = new Map<number | null, RuntimeNode[]>();
  for (const n of runtime) {
    const list = children.get(n.parent) ?? [];
    list.push(n);
    children.set(n.parent, list);
  }
  const mapping: Mapping = { byRuntimeUid: new Map(), mismatches: [], unmatched: 0 };
  const countUnmatched = (r: RuntimeNode) => {
    mapping.unmatched++;
    for (const c of children.get(r.uid) ?? []) countUnmatched(c);
  };

  const main = trees.get(mainTreeId);
  const roots = children.get(null) ?? [];
  if (!main) {
    mapping.mismatches.push(`The robot runs tree "${mainTreeId}", which is not in this project`);
    roots.forEach(countUnmatched);
    return mapping;
  }
  if (roots.length !== 1 || !main.root) {
    mapping.mismatches.push(`Tree "${mainTreeId}" has ${main.root ? 1 : 0} root node(s) here and ${roots.length} on the robot`);
    roots.forEach(countUnmatched);
    return mapping;
  }

  const visit = (r: RuntimeNode, e: BTNode, tree: TreeDef, prefix: string, depth: number) => {
    if (r.type !== e.type) {
      mapping.mismatches.push(`${tree.id}: expected ${e.type} "${e.attrs.name ?? e.type}" but the robot has ${r.type} "${r.name}"`);
      countUnmatched(r);
      return;
    }
    const path = joinPath(prefix, e.uid);
    mapping.byRuntimeUid.set(r.uid, { path, treeId: tree.id, nodeUid: e.uid });
    const rKids = children.get(r.uid) ?? [];

    if (e.type === "SubTree") {
      const sub = trees.get(e.attrs.ID ?? "");
      if (depth > 64) return; // recursive SubTrees; the robot would have refused to build this
      if (!sub || !sub.root) {
        mapping.mismatches.push(`${tree.id}: SubTree "${e.attrs.ID}" is not defined here`);
        rKids.forEach(countUnmatched);
        return;
      }
      if (rKids.length !== 1) {
        mapping.mismatches.push(`${tree.id}: SubTree "${e.attrs.ID}" has ${rKids.length} children on the robot`);
        rKids.forEach(countUnmatched);
        return;
      }
      visit(rKids[0], sub.root, sub, path, depth + 1);
      return;
    }

    const n = Math.min(rKids.length, e.children.length);
    for (let i = 0; i < n; i++) visit(rKids[i], e.children[i], tree, prefix, depth);
    if (rKids.length !== e.children.length) {
      mapping.mismatches.push(
        `${tree.id}: ${e.type} "${e.attrs.name ?? e.type}" has ${e.children.length} children here and ${rKids.length} on the robot`,
      );
      rKids.slice(n).forEach(countUnmatched);
    }
  };
  visit(roots[0], main.root, main, "", 0);
  return mapping;
}
