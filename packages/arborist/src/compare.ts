// Comparing two versions of a set of trees (two git revisions, a file before and after an edit, the
// trees a robot ran against the ones on disk, ...): each tree diffed (./tree_diff.ts) and merged
// into one drawable tree with a Mark per node (./diff_view.ts).

import { mergeAll, treeKey, type MergedTree } from "./diff_view.ts";
import type { NodeModel, TreeDef } from "./model.ts";
import { projectModels } from "./models.ts";
import { diffTreeDefs, type TreeDefDiff, type TreeDefStatus } from "./tree_diff.ts";

/** One side of a comparison. */
export interface TreeSet {
  trees: TreeDef[];
  /** Node types from that version's spec (loadTrees().specModels); builtins are added. */
  specModels?: NodeModel[];
}

export interface Comparison {
  /** Per-tree diffs, as sortTreeDiffs() orders them. */
  trees: TreeDefDiff[];
  /** Merged trees by tree key (see treeKey). */
  merged: Record<string, MergedTree>;
  /** Node types of both versions, the new one winning, so removed nodes still draw correctly. */
  models: Map<string, NodeModel>;
}

export function compareTrees(before: TreeSet, after: TreeSet): Comparison {
  const trees = diffTreeDefs(before.trees, after.trees);
  return { trees: sortTreeDiffs(trees), merged: mergeAll(trees), models: mergeModels(before, after) };
}

/** Node types from both versions, the new one winning, so removed nodes still draw correctly. */
export function mergeModels(before: TreeSet | undefined, after: TreeSet | undefined): Map<string, NodeModel> {
  const models = projectModels(after?.specModels ?? [], after?.trees ?? []);
  for (const [id, m] of projectModels(before?.specModels ?? [], before?.trees ?? [])) if (!models.has(id)) models.set(id, m);
  return models;
}

const STATUS_ORDER: Record<TreeDefStatus, number> = { changed: 0, renamed: 1, added: 2, removed: 3, unchanged: 4 };

/** Changed trees first, then renamed, added, removed, unchanged; by ID within each. */
export function sortTreeDiffs(trees: TreeDefDiff[]): TreeDefDiff[] {
  return [...trees].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || treeKey(a).localeCompare(treeKey(b)));
}

/** A change to step to: a merged node uid in the tree with key `key`. */
export interface ChangeStop {
  key: string;
  uid: string;
}

/** Changes to step through: those in changed trees (an unchanged tree's SubTree flags are only a pointer). */
export function changeStops(trees: TreeDefDiff[], merged: Record<string, MergedTree>): ChangeStop[] {
  return sortTreeDiffs(trees)
    .filter((t) => t.status !== "unchanged")
    .flatMap((t) => merged[treeKey(t)].changes.map((uid) => ({ key: treeKey(t), uid })));
}

/** The tree to show first: the first changed one, else the first. */
export function firstChangedTree(trees: TreeDefDiff[]): string | null {
  const sorted = sortTreeDiffs(trees);
  const t = sorted.find((x) => x.status !== "unchanged") ?? sorted[0];
  return t ? treeKey(t) : null;
}
