// Immutable edits on BTNode trees. Every function returns a new root and shares untouched subtrees,
// so the store can keep old roots around as undo history.

import type { BTNode } from "../shared/model.ts";

let counter = 0;
export function newUid(): string {
  return `e${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function makeNode(type: string, attrs: Record<string, string> = {}): BTNode {
  return { uid: newUid(), type, attrs, children: [] };
}

export function cloneWithNewUids(n: BTNode): BTNode {
  return { uid: newUid(), type: n.type, attrs: { ...n.attrs }, children: n.children.map(cloneWithNewUids) };
}

/** Applies `fn` to the node with `uid`; returns the same root object if nothing changed. */
export function mapNode(root: BTNode, uid: string, fn: (n: BTNode) => BTNode): BTNode {
  if (root.uid === uid) return fn(root);
  let changed = false;
  const children = root.children.map((c) => {
    const next = mapNode(c, uid, fn);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

export function contains(root: BTNode, uid: string): boolean {
  return root.uid === uid || root.children.some((c) => contains(c, uid));
}

export function parentOf(root: BTNode, uid: string): { parent: BTNode; index: number } | null {
  const i = root.children.findIndex((c) => c.uid === uid);
  if (i >= 0) return { parent: root, index: i };
  for (const c of root.children) {
    const r = parentOf(c, uid);
    if (r) return r;
  }
  return null;
}

/** Removes a node and its subtree. Returns null if the root itself was removed. */
export function removeNode(root: BTNode, uid: string): BTNode | null {
  if (root.uid === uid) return null;
  const p = parentOf(root, uid);
  if (!p) return root;
  return mapNode(root, p.parent.uid, (n) => ({ ...n, children: n.children.filter((c) => c.uid !== uid) }));
}

export function insertChild(root: BTNode, parentUid: string, index: number, child: BTNode): BTNode {
  return mapNode(root, parentUid, (n) => {
    const children = [...n.children];
    children.splice(Math.max(0, Math.min(index, children.length)), 0, child);
    return { ...n, children };
  });
}

export type DropZone = "before" | "after" | "inside";

/** Inserts `node` relative to `target`. Returns null if the drop is impossible (sibling of root). */
export function insertAt(root: BTNode, targetUid: string, zone: DropZone, node: BTNode): BTNode | null {
  if (zone === "inside") return insertChild(root, targetUid, Infinity, node);
  const p = parentOf(root, targetUid);
  if (!p) return null;
  return insertChild(root, p.parent.uid, zone === "before" ? p.index : p.index + 1, node);
}

/** Moves the subtree `uid` relative to `target`. Returns null for impossible moves. */
export function moveNode(root: BTNode, uid: string, targetUid: string, zone: DropZone): BTNode | null {
  if (uid === root.uid) return null;
  const moving = findIn(root, uid);
  if (!moving || contains(moving, targetUid)) return null;
  const without = removeNode(root, uid);
  if (!without) return null;
  return insertAt(without, targetUid, zone, moving);
}

export function findIn(root: BTNode, uid: string): BTNode | null {
  if (root.uid === uid) return root;
  for (const c of root.children) {
    const r = findIn(c, uid);
    if (r) return r;
  }
  return null;
}

/** Shifts a node among its siblings by `delta`. */
export function reorder(root: BTNode, uid: string, delta: number): BTNode {
  const p = parentOf(root, uid);
  if (!p) return root;
  const to = p.index + delta;
  if (to < 0 || to >= p.parent.children.length) return root;
  return mapNode(root, p.parent.uid, (n) => {
    const children = [...n.children];
    const [moved] = children.splice(p.index, 1);
    children.splice(to, 0, moved);
    return { ...n, children };
  });
}

/** Replaces node `uid` with `wrapper`, which gets the node as its (first) child. */
export function wrapNode(root: BTNode, uid: string, wrapper: BTNode): BTNode {
  const target = findIn(root, uid);
  if (!target) return root;
  const wrapped = { ...wrapper, children: [target, ...wrapper.children] };
  if (root.uid === uid) return wrapped;
  return mapNode(root, uid, () => wrapped);
}

/** Replaces node `uid` with its children (only valid where the parent can take them all). */
export function unwrapNode(root: BTNode, uid: string): BTNode | null {
  const target = findIn(root, uid);
  if (!target) return root;
  if (root.uid === uid) return target.children.length === 1 ? target.children[0] : null;
  const p = parentOf(root, uid)!;
  return mapNode(root, p.parent.uid, (n) => {
    const children = [...n.children];
    children.splice(p.index, 1, ...target.children);
    return { ...n, children };
  });
}

export function replaceNode(root: BTNode, uid: string, next: BTNode): BTNode {
  return mapNode(root, uid, () => next);
}

/** Every blackboard key referenced as {key} anywhere in the tree. */
export function blackboardKeys(root: BTNode | null): string[] {
  const keys = new Set<string>();
  const visit = (n: BTNode) => {
    for (const v of Object.values(n.attrs)) {
      for (const m of v.matchAll(/\{([^{}]+)\}/g)) keys.add(m[1]);
    }
    n.children.forEach(visit);
  };
  if (root) visit(root);
  return [...keys].sort();
}
