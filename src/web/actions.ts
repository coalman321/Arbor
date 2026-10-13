// Editing commands on the active tab's selection. Shared by keyboard shortcuts, the context menu,
// the node picker and the inspector.

import { allowedChildren, modelFor, projectModels, type BTNode, type NodeModel } from "@coalman321/arborist";
import { createTree, editRoot, fileNameFor, openTree, resolvePath, toast, useStore } from "./store.ts";
import {
  blackboardKeyTypes,
  cloneWithNewUids,
  findIn,
  insertAt,
  makeNode,
  moveNode,
  parentOf,
  removeNode,
  reorder,
  unwrapNode,
  wrapNode,
  type DropZone,
} from "./tree_ops.ts";

const get = useStore.getState;

export function models(): Map<string, NodeModel> {
  const s = get();
  return projectModels(s.specModels, Object.values(s.trees));
}

/** The selected node if it's editable (not inside an inline-expanded SubTree). */
export function selectedNode(): { treeId: string; node: BTNode; path: string } | null {
  const s = get();
  if (!s.active || !s.selection) return null;
  const r = resolvePath(s.trees, s.active, s.selection);
  if (!r || r.readOnly) return null;
  return { treeId: r.tree.id, node: r.node, path: s.selection };
}

/** A fresh node for a palette entry: "SubTree:<id>" makes <SubTree ID="id"/>. */
export function nodeForPaletteId(id: string): BTNode {
  if (id.startsWith("SubTree:")) return makeNode("SubTree", { ID: id.slice("SubTree:".length) });
  return makeNode(id);
}

export function canHaveMoreChildren(node: BTNode, m = models()): boolean {
  return node.children.length < allowedChildren(node, m)[1];
}

/** Picks a sensible drop zone when "inside" isn't possible (leaf or full decorator). */
export function effectiveZone(root: BTNode, target: BTNode, zone: DropZone, m = models()): DropZone | null {
  if (zone === "inside") return canHaveMoreChildren(target, m) ? "inside" : null;
  if (target.uid === root.uid) return null; // the root has no siblings
  const p = parentOf(root, target.uid);
  if (p && !canHaveMoreChildren(p.parent, m)) return null;
  return zone;
}

/** Inserts a new node in tree `treeId`; the tree's root if it's empty. Selects the new node. */
export function addNode(treeId: string, node: BTNode, targetUid: string | null, zone: DropZone): boolean {
  const tree = get().trees[treeId];
  if (!tree) return false;
  if (!tree.root) {
    editRoot(treeId, () => node);
    useStore.setState({ selection: node.uid });
    return true;
  }
  if (!targetUid) {
    toast("Drop the node onto an existing node to attach it", "error");
    return false;
  }
  const target = findIn(tree.root, targetUid);
  if (!target) return false;
  const z = effectiveZone(tree.root, target, zone);
  if (!z) {
    toast(zone === "inside" ? `${target.type} can't take another child` : "The root node can't have siblings", "error");
    return false;
  }
  const next = insertAt(tree.root, targetUid, z, node);
  if (!next) return false;
  editRoot(treeId, () => next);
  if (get().active === treeId) useStore.setState({ selection: node.uid });
  return true;
}

export function moveExisting(treeId: string, uid: string, targetUid: string, zone: DropZone): boolean {
  const tree = get().trees[treeId];
  if (!tree?.root) return false;
  const target = findIn(tree.root, targetUid);
  if (!target) return false;
  const z = effectiveZone(tree.root, target, zone);
  if (!z) return false;
  const next = moveNode(tree.root, uid, targetUid, z);
  if (!next) return false;
  editRoot(treeId, () => next);
  return true;
}

export function deleteSelected() {
  const sel = selectedNode();
  if (!sel) return;
  const root = get().trees[sel.treeId].root!;
  const p = parentOf(root, sel.node.uid);
  editRoot(sel.treeId, (r) => (r ? removeNode(r, sel.node.uid) : r));
  useStore.setState({ selection: p ? p.parent.uid : null });
}

/** Removes the selected node but keeps its children in its place. */
export function unwrapSelected() {
  const sel = selectedNode();
  if (!sel) return;
  const root = get().trees[sel.treeId].root!;
  const p = parentOf(root, sel.node.uid);
  const m = models();
  if (p) {
    const room = allowedChildren(p.parent, m)[1] - p.parent.children.length + 1;
    if (sel.node.children.length > room) return toast(`${p.parent.type} can't take ${sel.node.children.length} children`, "error");
  } else if (sel.node.children.length !== 1) {
    return toast("The root can only be removed if it has exactly one child", "error");
  }
  const next = unwrapNode(root, sel.node.uid);
  if (next === null) return;
  editRoot(sel.treeId, () => next);
  useStore.setState({ selection: sel.node.children[0]?.uid ?? p?.parent.uid ?? null });
}

export function duplicateSelected() {
  const sel = selectedNode();
  if (!sel) return;
  addNode(sel.treeId, cloneWithNewUids(sel.node), sel.node.uid, "after");
}

export function copySelected(cut = false) {
  const s = get();
  if (!s.active || !s.selection) return;
  const r = resolvePath(s.trees, s.active, s.selection);
  if (!r) return;
  useStore.setState({ clipboard: r.node });
  if (cut) deleteSelected();
  else toast(`Copied ${r.node.attrs.name ?? r.node.type}`);
}

export function pasteIntoSelected() {
  const s = get();
  if (!s.clipboard || !s.active) return;
  const sel = selectedNode();
  const tree = s.trees[s.active];
  const node = cloneWithNewUids(s.clipboard);
  if (!tree.root) return void addNode(tree.id, node, null, "inside");
  if (!sel) return toast("Select where to paste", "error");
  const zone = canHaveMoreChildren(sel.node) ? "inside" : "after";
  addNode(sel.treeId, node, sel.node.uid, zone);
}

export function moveSelected(delta: number) {
  const sel = selectedNode();
  if (!sel) return;
  editRoot(sel.treeId, (r) => (r ? reorder(r, sel.node.uid, delta) : r));
}

export function wrapSelected(type: string) {
  const sel = selectedNode();
  if (!sel) return;
  const wrapper = nodeForPaletteId(type);
  const m = models();
  if (allowedChildren(wrapper, m)[1] < 1) return toast(`${type} can't have children`, "error");
  editRoot(sel.treeId, (r) => (r ? wrapNode(r, sel.node.uid, wrapper) : r));
  useStore.setState({ selection: wrapper.uid });
}

/** Changes the selected node's type, keeping children, name and same-named ports. */
export function replaceSelected(type: string) {
  const sel = selectedNode();
  if (!sel) return;
  const fresh = nodeForPaletteId(type);
  const m = models();
  const model = modelFor(fresh, m);
  const keep = new Set(["name", ...(model?.ports.map((p) => p.name) ?? [])]);
  const attrs = { ...Object.fromEntries(Object.entries(sel.node.attrs).filter(([k]) => keep.has(k) || k.startsWith("_"))), ...fresh.attrs };
  const next: BTNode = { ...sel.node, type: fresh.type, attrs };
  if (next.children.length > allowedChildren(next, m)[1]) return toast(`${type} can't have ${next.children.length} children`, "error");
  editRoot(sel.treeId, (r) => (r ? replaceNodeIn(r, sel.node.uid, next) : r));
}

function replaceNodeIn(root: BTNode, uid: string, next: BTNode): BTNode {
  if (root.uid === uid) return next;
  return { ...root, children: root.children.map((c) => replaceNodeIn(c, uid, next)) };
}

/**
 * Moves the selected subtree into a new tree `newId` and replaces it with <SubTree ID="newId"/>.
 * Blackboard keys it uses become the new tree's ports and are remapped 1:1, so behavior is unchanged.
 */
export function extractToSubtree(treeId: string, uid: string, newId: string, file: string): string | null {
  const tree = get().trees[treeId];
  const node = tree?.root ? findIn(tree.root, uid) : null;
  if (!node) return "Node not found";
  const keys = new Set<string>();
  const visit = (n: BTNode) => {
    for (const v of Object.values(n.attrs)) for (const m of v.matchAll(/\{([^{}]+)\}/g)) keys.add(m[1]);
    n.children.forEach(visit);
  };
  visit(node);
  const types = blackboardKeyTypes(node, models());
  const ports = [...keys].sort().map((k) => ({ name: k, direction: "inout" as const, ...(types.has(k) ? { type: types.get(k) } : {}) }));
  const err = createTree(newId, file || fileNameFor(newId), cloneWithNewUids(node), ports);
  if (err) return err;
  const ref = makeNode("SubTree", { ID: newId, ...Object.fromEntries([...keys].sort().map((k) => [k, `{${k}}`])) });
  editRoot(treeId, (r) => (r ? replaceNodeIn(r, uid, ref) : r));
  openTree(treeId, ref.uid);
  return null;
}
