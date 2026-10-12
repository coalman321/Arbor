// Compare mode: the project's trees at two git revisions (or a revision and the files on disk),
// each drawn as one merged tree (see Arborist's diff_view.ts). It keeps its own state and leaves
// the editor's alone, so closing it returns to editing exactly where you were.

import { useMemo } from "react";
import {
  changeStops,
  diffTreeDefs,
  findNode,
  firstChangedTree,
  mergeAll,
  mergeModels,
  treeKey,
  type BTNode,
  type ChangeStop,
  type Mark,
  type MergedTree,
  type NodeModel,
  type TreeDefDiff,
} from "@coalman321/arborist";
import { WORKTREE, type GitInfo, type RevSnapshot } from "../shared/model.ts";
import { api } from "./api.ts";
import { toast, useStore } from "./store.ts";

export type GitRevs = Extract<GitInfo, { available: true }>;

export interface DiffState {
  /** The commit compared against: the "old" side. The "new" side is always the files on disk. */
  base: string;
  status: "loading" | "ready" | "error";
  error?: string;
  git: GitRevs;
  /** How many commits of history to list (raised by "Show more"). */
  historyLimit: number;
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
const HISTORY_PAGE = 200;

export async function openCompare() {
  let git: GitInfo;
  try {
    git = await api.gitInfo(HISTORY_PAGE);
  } catch (e) {
    return toast(`Couldn't read the git history: ${(e as Error).message}`, "error");
  }
  if (!git.available) return toast(git.reason, "error");
  if (!git.head) return toast("This repository has no commits yet", "error");
  const base = defaultBase(git);
  set({
    diff: { base, status: "loading", git, historyLimit: HISTORY_PAGE, trees: [], merged: {}, active: null, selection: null },
    menu: null,
    picker: null,
  });
  await compare(base);
}

/**
 * The checked-out commit if the files differ from it. Otherwise they match it, so start from the
 * version before the last commit that changed the trees, to show what that commit did.
 */
function defaultBase(git: GitRevs): string {
  // The newest listed commit has the same trees as HEAD (the list skips commits that don't touch
  // them), and picking it keeps the selection visible in the history.
  if (git.dirty || git.commits.length < 2) return git.commits[0]?.sha ?? git.head!;
  return git.commits[1].sha;
}

export function closeCompare() {
  request++;
  set({ diff: null });
}

/** Compares the files on disk with the project at commit `base`. */
export async function compare(base: string) {
  const d = get().diff;
  if (!d) return;
  const id = ++request;
  set({ diff: { ...d, base, status: "loading", error: undefined } });
  try {
    const [o, n] = await Promise.all([api.gitSnapshot(base), api.gitSnapshot(WORKTREE)]);
    const cur = get().diff;
    if (id !== request || !cur) return;
    const trees = diffTreeDefs(o.snapshot.trees, n.snapshot.trees);
    const merged = mergeAll(trees);
    const keep = cur.active && merged[cur.active] && trees.find((t) => treeKey(t) === cur.active)?.status !== "unchanged";
    const active = keep ? cur.active : firstChangedTree(trees);
    // Merged uids come from the parse, so a selection can't be carried over to new content.
    set({ diff: { ...cur, old: o, new: n, trees, merged, active, selection: null, status: "ready" } });
  } catch (e) {
    if (id !== request || !get().diff) return;
    set({ diff: { ...get().diff!, status: "error", error: (e as Error).message } });
  }
}

/** Re-reads the history (after a commit, say), optionally listing more of it. */
export async function reloadGitInfo(limit = get().diff?.historyLimit ?? HISTORY_PAGE) {
  try {
    const git = await api.gitInfo(limit);
    const d = get().diff;
    if (d && git.available) set({ diff: { ...d, git, historyLimit: limit } });
  } catch (e) {
    toast(`Couldn't read the git history: ${(e as Error).message}`, "error");
  }
}

export function showMoreHistory() {
  void reloadGitInfo((get().diff?.historyLimit ?? HISTORY_PAGE) + HISTORY_PAGE);
}

/** Called when files change on disk: the "new" side is out of date. */
export function refreshCompare() {
  const d = get().diff;
  if (!d) return;
  void compare(d.base);
  void reloadGitInfo();
}

export function showDiffTree(key: string, selection: string | null = null) {
  const d = get().diff;
  if (d?.merged[key]) set({ diff: { ...d, active: key, selection } });
}

/** Every change across all trees, and which one is selected (-1 if none). */
export function useStops(): { stops: ChangeStop[]; index: number } {
  const d = useStore((s) => s.diff);
  // Recomputed when the comparison changes, not on every selection.
  const ready = d?.status === "ready";
  const trees = d?.trees;
  const merged = d?.merged;
  const stops = useMemo(() => (ready && trees && merged ? changeStops(trees, merged) : []), [ready, trees, merged]);
  const index = stops.findIndex((s) => s.key === d?.active && s.uid === d?.selection);
  return { stops, index };
}

/** Selects the next (or previous) change, moving on to the next changed tree at the end of one. */
export function stepChange(delta: 1 | -1) {
  const d = get().diff;
  if (!d || d.status !== "ready") return;
  const stops = changeStops(d.trees, d.merged);
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
  return mergeModels(oldRev?.snapshot, newRev?.snapshot);
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
