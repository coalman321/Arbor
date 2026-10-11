// The viewer for hosts that don't use React: one call mounts it into an element, and methods drive
// it. The built "@coalman321/arborist/mount" bundles React, React Flow and the styles, so it needs
// nothing else.

import { createRef } from "react";
import { createRoot } from "react-dom/client";
import { compareTrees, type Comparison, type TreeSet } from "./compare.ts";
import { loadTrees, type LoadedTrees, type LoadInput } from "./load.ts";
import type { NodeModel, TreeDef } from "./model.ts";
import type { RuntimeNode, StatusChange, StatusEntry } from "./protocol.ts";
import { TreeViewer, type TreeViewerHandle, type TreeViewerProps } from "./react/TreeViewer.tsx";
import type { Statuses } from "./status.ts";
import { StatusTracker } from "./tracker.ts";
import css from "./viewer.css?inline";

/** Display options; see TreeViewerProps. */
export type TreeViewerOptions = Pick<
  TreeViewerProps,
  | "treeId"
  | "onTreeChange"
  | "dir"
  | "decoratorFrames"
  | "explainEdges"
  | "diagnostics"
  | "selection"
  | "onSelect"
  | "theme"
  | "controls"
  | "background"
  | "className"
  | "style"
>;

export interface MountedTreeViewer {
  /** Parses tree files (and a node spec) and shows them. Returns what was loaded, diagnostics included. */
  load(input: LoadInput): LoadedTrees;
  /** Shows already-parsed trees. */
  setTrees(trees: TreeDef[], models?: Map<string, NodeModel>): void;
  /** Switches to the tree with this ID. */
  showTree(treeId: string): void;
  /**
   * Shows what changed between two versions (each parsed XML, or loadTrees() output) instead of the
   * trees; clearComparison() goes back. Returns the comparison, e.g. to list the changed trees.
   */
  compare(before: LoadInput | TreeSet, after: LoadInput | TreeSet): Comparison;
  clearComparison(): void;
  /** The tree the robot runs, in BT.CPP's depth-first order (btlive "tree"); clears statuses. */
  setRuntimeTree(treeId: string, nodes: RuntimeNode[]): void;
  /** Every node's status at time `t` (btlive "snapshot"), by runtime UID. */
  applySnapshot(statuses: StatusEntry[], t: number): void;
  /** Status changes, in time order (btlive "status"), by runtime UID. */
  applyStatusChanges(changes: StatusChange[]): void;
  /** Statuses already mapped onto tree nodes, for hosts that track them themselves. */
  setStatuses(statuses: Statuses, liveTreeId?: string): void;
  clearStatuses(): void;
  /** The runtime tree's pairing with the loaded trees: why some nodes show no status. */
  readonly mismatches: string[];
  setOptions(options: Partial<TreeViewerOptions>): void;
  fit(): void;
  /** Centers a node by instance path ("n4", or "n4/n2" inside an expanded SubTree). */
  reveal(path: string): void;
  destroy(): void;
}

const isLoadInput = (x: LoadInput | TreeSet): x is LoadInput => "files" in x;

/** Adds the viewer's styles to the document (or shadow root) holding `element`, once. */
function injectStyles(element: HTMLElement) {
  const target = element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot) : document.head;
  if (target.querySelector("style[data-arborist]")) return;
  const style = document.createElement("style");
  style.dataset.arborist = "";
  style.textContent = css;
  target.appendChild(style);
}

export function createTreeViewer(element: HTMLElement, options: TreeViewerOptions = {}): MountedTreeViewer {
  injectStyles(element);
  const root = createRoot(element);
  const handle = createRef<TreeViewerHandle>();
  const tracker = new StatusTracker();
  let opts = options;
  let trees: TreeDef[] = [];
  let models: Map<string, NodeModel> | undefined;
  let comparison: Comparison | null = null;
  let statuses: Statuses | undefined;
  let liveTreeId: string | null = null;

  const render = () =>
    root.render(
      <TreeViewer
        ref={handle}
        {...opts}
        trees={trees}
        models={models}
        compare={comparison}
        statuses={statuses ?? tracker.statuses}
        liveTreeId={statuses ? liveTreeId : (tracker.treeId ?? null)}
      />,
    );
  const toSet = (x: LoadInput | TreeSet): TreeSet => (isLoadInput(x) ? loadTrees(x) : x);

  const viewer: MountedTreeViewer = {
    load(input) {
      const loaded = loadTrees(input);
      viewer.setTrees(loaded.trees, loaded.models);
      return loaded;
    },
    setTrees(t, m) {
      trees = t;
      models = m;
      tracker.setTrees(t);
      render();
    },
    showTree(treeId) {
      opts = { ...opts, treeId };
      render();
    },
    compare(before, after) {
      comparison = compareTrees(toSet(before), toSet(after));
      render();
      return comparison;
    },
    clearComparison() {
      comparison = null;
      render();
    },
    setRuntimeTree(treeId, nodes) {
      statuses = undefined;
      tracker.setRuntimeTree(treeId, nodes);
      render();
    },
    applySnapshot(entries, t) {
      tracker.applySnapshot(entries, t);
      render();
    },
    applyStatusChanges(changes) {
      tracker.applyChanges(changes);
      render();
    },
    setStatuses(s, treeId) {
      statuses = s;
      liveTreeId = treeId ?? null;
      render();
    },
    clearStatuses() {
      statuses = undefined;
      tracker.clear();
      render();
    },
    get mismatches() {
      return tracker.mapping?.mismatches ?? [];
    },
    setOptions(o) {
      opts = { ...opts, ...o };
      render();
    },
    fit: () => handle.current?.fit(),
    reveal: (path) => handle.current?.reveal(path),
    destroy: () => root.unmount(),
  };
  render();
  return viewer;
}

export type { TreeViewerHandle, TreeViewerProps } from "./react/TreeViewer.tsx";
// Everything else a host needs, from the same bundle.
export * from "./index.ts";
