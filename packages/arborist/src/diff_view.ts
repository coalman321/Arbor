// Turns a tree diff into one tree the normal layout can draw: the new version, with removed nodes
// put back where they were ("ghosts") and a marker left where a node moved away from. Every node of
// the merged tree has a Mark saying what happened to it.
//
// Old and new nodes share uid numbering (both are "n1", "n2", ... per parse), so merged uids carry
// a prefix: N<uid> for nodes of the new version, O<uid> for removed nodes, M<uid> for markers.

import { visibleAttrs, type Line } from "./layout.ts";
import { walk, type BTNode, type TreeDef } from "./model.ts";
import type { NodeChange, TreeDefDiff } from "./tree_diff.ts";

export type MarkKind = "added" | "removed" | "moved" | "moved-away" | "changed" | "same";

export interface Mark {
  kind: MarkKind;
  /** Attributes or type changed; a moved node can also be edited. */
  edited: boolean;
  reordered: boolean;
  change?: NodeChange;
  oldNode?: BTNode;
  newNode?: BTNode;
  /** For a moved node, its marker; for a marker, the node it stands for. */
  partner?: string;
  /**
   * The node only gained or lost a parent around it (it was wrapped in a Retry, say). The added or
   * removed parent is the change; the node itself is not reported as moved.
   */
  nesting?: "wrapped" | "unwrapped";
  /** A SubTree whose tree changed between the two versions. */
  innerChange?: boolean;
}

export interface MergedTree {
  key: string;
  diff: TreeDefDiff;
  def: TreeDef;
  marks: Map<string, Mark>;
  /** Merged uids worth stepping through, in display order. */
  changes: string[];
}

/** The ID a tree diff is listed under: the new ID, or the old one for a removed tree. */
export function treeKey(d: TreeDefDiff): string {
  return d.new?.id ?? d.old!.id;
}

export function mergeTree(d: TreeDefDiff): MergedTree {
  const { nodes } = d;
  const marks = new Map<string, Mark>();
  const oldById = new Map<string, BTNode>();
  const oldParent = new Map<string, BTNode | null>();
  const newParent = new Map<string, BTNode | null>();
  walk(d.old?.root ?? null, (n, p) => {
    oldById.set(n.uid, n);
    oldParent.set(n.uid, p);
  });
  walk(d.new?.root ?? null, (n, p) => newParent.set(n.uid, p));

  /** Whether a moved node only changed nesting: past added/removed parents, its surroundings match. */
  const nesting = (oldUid: string, newUid: string): Mark["nesting"] => {
    const first = newParent.get(newUid) ?? null;
    let a = first;
    while (a && nodes.added.has(a.uid)) a = newParent.get(a.uid) ?? null;
    let b = oldParent.get(oldUid) ?? null;
    while (b && nodes.removed.has(b.uid)) b = oldParent.get(b.uid) ?? null;
    const same = a && b ? nodes.oldToNew.get(b.uid) === a.uid : !a && !b;
    if (!same) return undefined;
    return first && nodes.added.has(first.uid) ? "wrapped" : "unwrapped";
  };

  const ghost = (o: BTNode): BTNode => {
    const uid = `O${o.uid}`;
    marks.set(uid, { kind: "removed", edited: false, reordered: false, oldNode: o });
    return { uid, type: o.type, attrs: o.attrs, children: o.children.flatMap(leftBehind) };
  };
  const marker = (o: BTNode, newUid: string): BTNode => {
    const uid = `M${o.uid}`;
    marks.set(uid, { kind: "moved-away", edited: false, reordered: false, oldNode: o, partner: `N${newUid}` });
    return { uid, type: o.type, attrs: o.attrs, children: [] };
  };
  /** What an old child that is no longer here leaves in the merged tree. */
  const leftBehind = (o: BTNode): BTNode[] => {
    if (nodes.removed.has(o.uid)) return [ghost(o)];
    const newUid = nodes.oldToNew.get(o.uid)!;
    return nesting(o.uid, newUid) ? [] : [marker(o, newUid)];
  };

  const fromNew = (n: BTNode): BTNode => {
    const uid = `N${n.uid}`;
    const o = oldById.get(nodes.newToOld.get(n.uid) ?? "");
    if (!o) {
      marks.set(uid, { kind: "added", edited: false, reordered: false, newNode: n });
      return { uid, type: n.type, attrs: n.attrs, children: n.children.map(fromNew) };
    }
    const c = nodes.matched.get(n.uid)!;
    const edited = !!c.type || Object.keys(c.attrs).length > 0;
    const nest = c.moved ? nesting(o.uid, n.uid) : undefined;
    const moved = (c.moved && !nest) || c.reordered;
    marks.set(uid, { kind: moved ? "moved" : edited ? "changed" : "same", edited, reordered: c.reordered, change: c, oldNode: o, newNode: n, nesting: nest });
    const children = n.children.map(fromNew);
    // Put back, in their old order, the children this node had that are no longer under it.
    let at = 0;
    for (const oc of o.children) {
      const nc = nodes.oldToNew.get(oc.uid);
      const i = nc === undefined ? -1 : children.findIndex((x) => x.uid === `N${nc}`);
      if (i >= 0) at = i + 1;
      else for (const g of leftBehind(oc)) children.splice(at++, 0, g);
    }
    return { uid, type: n.type, attrs: n.attrs, children };
  };

  const root = d.new?.root ? fromNew(d.new.root) : d.old?.root ? ghost(d.old.root) : null;
  for (const [uid, m] of marks) {
    const partner = m.kind === "moved-away" ? marks.get(m.partner!) : undefined;
    if (partner) partner.partner = uid;
  }
  return { key: treeKey(d), diff: d, def: { ...(d.new ?? d.old)!, root }, marks, changes: [] };
}

/** Merges every tree, then flags SubTrees whose tree changed and lists each tree's changes. */
export function mergeAll(diffs: TreeDefDiff[]): Record<string, MergedTree> {
  const out: Record<string, MergedTree> = {};
  for (const d of diffs) out[treeKey(d)] = mergeTree(d);
  const changed = new Set(diffs.filter((d) => d.status !== "unchanged").map(treeKey));
  for (const m of Object.values(out)) {
    walk(m.def.root, (n) => {
      const mark = m.marks.get(n.uid)!;
      if (n.type === "SubTree" && changed.has(n.attrs.ID ?? "")) mark.innerChange = true;
      if (mark.kind !== "same" || mark.innerChange) m.changes.push(n.uid);
    });
  }
  return out;
}

/** Port lines for a node with edits: changed attributes first (old and new), then the rest. */
export function diffLines(node: BTNode, mark: Mark | undefined): Line[] | undefined {
  const c = mark?.change;
  if (!c || !mark.edited) return undefined;
  const changed: Line[] = [];
  if (c.type) changed.push({ key: "type", value: c.type.new, old: c.type.old, change: "changed" });
  for (const [key, { old, new: value }] of Object.entries(c.attrs)) {
    if (value === undefined) changed.push({ key, value: old!, change: "removed" });
    else if (old === undefined) changed.push({ key, value, change: "added" });
    else changed.push({ key, value, old, change: "changed" });
  }
  return [...changed, ...visibleAttrs(node).filter((l) => !(l.key in c.attrs))];
}
