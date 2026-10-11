// Compare mode: the project's trees at two git revisions (or a revision and the files on disk),
// each drawn as one merged tree (see diff_view.ts). It keeps its own state and leaves the editor's
// alone, so closing it returns to editing exactly where you were.

import { useMemo } from "react";
import { findNode, WORKTREE, type BTNode, type GitInfo, type NodeModel, type RevSnapshot } from "../shared/model.ts";
import { diffTreeDefs, type TreeDefDiff, type TreeDefStatus } from "../shared/tree_diff.ts";
import { projectModels } from "../shared/validate.ts";
import { api } from "./api.ts";
import { mergeAll, treeKey, type Mark, type MergedTree } from "./diff_view.ts";
import { toast, useStore } from "./store.ts";

export type GitRevs = Extract<GitInfo, { available: true }>;

export interface DiffState {
  /** Revisions compared: old ("from") and new ("to"). Either may be WORKTREE. */
  base: string;
  target: string;
  status: "loading" | "ready" | "error";
  error?: string;
  git: GitRevs;
  old?: RevSnapshot;
  new?: RevSnapshot;
  trees: TreeDefDiff[];
  /** Merged trees by tree key (see treeKey). */
  merged: Record<string, MergedTree>;
  /** Key of the tree shown. */
  active: string | null;
  /** Instance path of the selected node in the merged tree. */
  selection: string | null;
}

const get = useStore.getState;
const set = useStore.setState;
/** Answers to an older compare() that arrive late are dropped. */
let request = 0;

export async function openCompare() {
  let git: GitInfo;
  try {
    git = await api.gitInfo();
  } catch (e) {
    return toast(`Couldn't read the git history: ${(e as Error).message}`, "error");
  }
  if (!git.available) return toast(git.reason, "error");
  const [base, target] = defaultRevs(git);
  set({ diff: { base, target, status: "loading", git, trees: [], merged: {}, active: null, selection: null }, menu: null, picker: null });
  await compare(base, target);
}

/** Uncommitted changes if there are any, else what the last commit to touch the trees changed. */
function defaultRevs(git: GitRevs): [string, string] {
  if (git.dirty || git.commits.length === 0) return ["HEAD", WORKTREE];
  if (git.commits.length === 1) return [git.commits[0].sha, WORKTREE];
  return [git.commits[1].sha, git.commits[0].sha];
}

export function closeCompare() {
  request++;
  set({ diff: null });
}

export async function compare(base: string, target: string) {
  const d = get().diff;
  if (!d) return;
  const id = ++request;
  set({ diff: { ...d, base, target, status: "loading", error: undefined } });
  try {
    const [o, n] = await Promise.all([api.gitSnapshot(base), api.gitSnapshot(target)]);
    const cur = get().diff;
    if (id !== request || !cur) return;
    const trees = diffTreeDefs(o.snapshot.trees, n.snapshot.trees);
    const merged = mergeAll(trees);
    const sorted = sortTreeDiffs(trees);
    const firstChanged = sorted.find((t) => t.status !== "unchanged") ?? sorted[0];
    const active = cur.active && merged[cur.active] ? cur.active : firstChanged ? treeKey(firstChanged) : null;
    // Merged uids come from the parse, so a selection can't be carried over to new content.
    set({ diff: { ...cur, old: o, new: n, trees, merged, active, selection: null, status: "ready" } });
  } catch (e) {
    if (id !== request || !get().diff) return;
    set({ diff: { ...get().diff!, status: "error", error: (e as Error).message } });
  }
}

/** Re-reads the branches and commits offered in the pickers. */
export async function reloadGitInfo() {
  try {
    const git = await api.gitInfo();
    const d = get().diff;
    if (d && git.available) set({ diff: { ...d, git } });
  } catch {
    // keep the list we have
  }
}

/** Called when files change on disk: a comparison with the working tree is now out of date. */
export function refreshCompare() {
  const d = get().diff;
  if (d && (d.base === WORKTREE || d.target === WORKTREE)) void compare(d.base, d.target);
}

export function showDiffTree(key: string, selection: string | null = null) {
  const d = get().diff;
  if (d?.merged[key]) set({ diff: { ...d, active: key, selection } });
}

const STATUS_ORDER: Record<TreeDefStatus, number> = { changed: 0, renamed: 1, added: 2, removed: 3, unchanged: 4 };

/** Changed trees first, then renamed, added, removed, unchanged; by ID within each. */
export function sortTreeDiffs(trees: TreeDefDiff[]): TreeDefDiff[] {
  return [...trees].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || treeKey(a).localeCompare(treeKey(b)));
}

interface Stop {
  key: string;
  uid: string;
}

/** Changes to step through: those in changed trees (an unchanged tree's SubTree flags are only a pointer). */
function stopsOf(trees: TreeDefDiff[], merged: Record<string, MergedTree>): Stop[] {
  return sortTreeDiffs(trees)
    .filter((t) => t.status !== "unchanged")
    .flatMap((t) => merged[treeKey(t)].changes.map((uid) => ({ key: treeKey(t), uid })));
}

/** Every change across all trees, and which one is selected (-1 if none). */
export function useStops(): { stops: Stop[]; index: number } {
  const d = useStore((s) => s.diff);
  // Recomputed when the comparison changes, not on every selection.
  const ready = d?.status === "ready";
  const trees = d?.trees;
  const merged = d?.merged;
  const stops = useMemo(() => (ready && trees && merged ? stopsOf(trees, merged) : []), [ready, trees, merged]);
  const index = stops.findIndex((s) => s.key === d?.active && s.uid === d?.selection);
  return { stops, index };
}

/** Selects the next (or previous) change, moving on to the next changed tree at the end of one. */
export function stepChange(delta: 1 | -1) {
  const d = get().diff;
  if (!d || d.status !== "ready") return;
  const stops = stopsOf(d.trees, d.merged);
  if (!stops.length) return;
  const cur = stops.findIndex((s) => s.key === d.active && s.uid === d.selection);
  let i: number;
  if (cur >= 0) i = (cur + delta + stops.length) % stops.length;
  else {
    const inTree = stops.map((s, j) => (s.key === d.active ? j : -1)).filter((j) => j >= 0);
    i = inTree.length ? (delta > 0 ? inTree[0] : inTree[inTree.length - 1]) : delta > 0 ? 0 : stops.length - 1;
  }
  const stop = stops[i];
  set({ diff: { ...d, active: stop.key, selection: stop.uid } });
  if (stop.key === d.active) requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("bt-reveal", { detail: stop.uid })));
}

/** Node types from both versions, the new one winning, so removed nodes still draw correctly. */
export function mergedModels(oldRev: RevSnapshot | undefined, newRev: RevSnapshot | undefined): Map<string, NodeModel> {
  const models = projectModels(newRev?.snapshot.specModels ?? [], newRev?.snapshot.trees ?? []);
  for (const [id, m] of projectModels(oldRev?.snapshot.specModels ?? [], oldRev?.snapshot.trees ?? [])) if (!models.has(id)) models.set(id, m);
  return models;
}

export function useDiffMark(treeId: string, uid: string): Mark | undefined {
  return useStore((s) => s.diff?.merged[treeId]?.marks.get(uid));
}

/** The node an instance path in the merged view refers to, looking into expanded SubTrees. */
export function resolveDiffPath(d: DiffState, path: string): { tree: MergedTree; node: BTNode; mark: Mark; prefix: string } | null {
  let tree = d.active ? d.merged[d.active] : undefined;
  if (!tree) return null;
  const parts = path.split("/");
  let node: BTNode | null = null;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      if (node?.type !== "SubTree") return null;
      tree = d.merged[node.attrs.ID ?? ""];
      if (!tree) return null;
    }
    node = findNode(tree.def.root, parts[i]);
    if (!node) return null;
  }
  return node ? { tree, node, mark: tree.marks.get(node.uid)!, prefix: parts.slice(0, -1).join("/") } : null;
}
