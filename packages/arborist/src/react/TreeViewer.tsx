// A read-only view of one tree at a time, with live statuses and diffs: what a host embeds. It
// keeps its own view state (expanded SubTrees, which tree is shown, the selection unless the host
// controls it) and takes everything else as props.

import { Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ForwardedRef } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import { firstChangedTree, type Comparison } from "../compare.ts";
import { layoutTree } from "../layout.ts";
import type { Diagnostic, NodeModel, TreeDef } from "../model.ts";
import { modelFor, projectModels } from "../models.ts";
import { NO_STATUSES, type Statuses } from "../status.ts";
import type { MergedTree } from "../diff_view.ts";
import { ViewerContext, type ViewerContextValue } from "./context.ts";
import { diffEdgeClass, diffLinesFor, diffMark } from "./diff.ts";
import type { BTFlowEdge } from "./BTEdge.tsx";
import type { BTFlowNode } from "./BTNodeView.tsx";
import { boxesByPath, edgeTypes, flowEdges, flowNodes, nodeRect, nodeTypes, problemsByNode } from "./flow.ts";

export interface TreeViewerProps {
  /** The trees that can be shown (SubTrees open and expand into them), e.g. loadTrees().trees. */
  trees?: TreeDef[];
  /** Node models by ID, e.g. loadTrees().models; builtins only if omitted. */
  models?: Map<string, NodeModel>;
  /**
   * When set, shows this comparison (compareTrees()) instead of `trees`: each tree merged from both
   * versions, with what changed marked.
   */
  compare?: Comparison | null;
  /** The tree to show. Changing it switches trees; the user can still open SubTrees. Defaults to the first. */
  treeId?: string | null;
  /** Called when the tree shown changes because the user opened another one. */
  onTreeChange?: (treeId: string) => void;
  dir?: "TB" | "LR";
  /** Draw decorators as frames around their child's subtree (default true). */
  decoratorFrames?: boolean;
  /** Describe decorators and label edges in plain words (default false). */
  explainEdges?: boolean;
  /** Node statuses to draw (see foldStatusChanges, snapshotStatuses). */
  statuses?: Statuses;
  /**
   * The tree the statuses' instance paths are relative to (the robot's main tree). Shown, it gets
   * per-instance statuses; any other tree, the latest status of each node's instances.
   */
  liveTreeId?: string | null;
  /** Diagnostics about nodes, drawn as error/warning badges. */
  diagnostics?: Diagnostic[];
  /** Selected node path; leave undefined to let the viewer keep its own. */
  selection?: string | null;
  onSelect?: (path: string | null) => void;
  /** Color scheme; "auto" (default) follows prefers-color-scheme. */
  theme?: "light" | "dark" | "auto";
  /** Zoom buttons (default true). */
  controls?: boolean;
  /** Dotted background (default true). */
  background?: boolean;
  className?: string;
  style?: CSSProperties;
}

export interface TreeViewerHandle {
  /** Zooms to fit the whole tree. */
  fit(): void;
  /** Centers the node at `path` (an instance path: "n4", or "n4/n2" inside an expanded SubTree). */
  reveal(path: string): void;
}

interface ViewState {
  statuses: Statuses;
  selection: string | null;
  merged: Record<string, MergedTree> | null;
}

export const TreeViewer = forwardRef<TreeViewerHandle, TreeViewerProps>(function TreeViewer(props, ref) {
  const { theme = "auto", className, style } = props;
  return (
    <div
      className={`arbor-viewer ${className ?? ""}`}
      data-theme={theme === "auto" ? undefined : theme}
      style={{ position: "relative", width: "100%", height: "100%", ...style }}
    >
      <ReactFlowProvider>
        <Viewer {...props} handle={ref} />
      </ReactFlowProvider>
    </div>
  );
});

function Viewer(props: TreeViewerProps & { handle: ForwardedRef<TreeViewerHandle> }) {
  const { compare, dir = "TB", decoratorFrames = true, explainEdges = false, liveTreeId, onSelect, onTreeChange } = props;
  const flow = useReactFlow();

  // Per-node state lives in a store, so a status change re-renders only the nodes it concerns.
  const [store] = useState(() => createStore<ViewState>(() => ({ statuses: NO_STATUSES, selection: null, merged: null })));
  const [ownSelection, setOwnSelection] = useState<string | null>(null);
  const selection = props.selection !== undefined ? props.selection : ownSelection;
  const merged = compare?.merged ?? null;
  useLayoutEffect(() => store.setState({ statuses: props.statuses ?? NO_STATUSES, selection, merged }), [store, props.statuses, selection, merged]);

  const trees = useMemo<Record<string, TreeDef>>(
    () =>
      merged ? Object.fromEntries(Object.entries(merged).map(([k, m]) => [k, m.def])) : Object.fromEntries((props.trees ?? []).map((t) => [t.id, t])),
    [merged, props.trees],
  );
  const models = useMemo(() => compare?.models ?? props.models ?? projectModels([], props.trees ?? []), [compare, props.models, props.trees]);

  // The tree shown: the host's choice, until the user opens another.
  const [opened, setOpened] = useState<string | null>(null);
  useEffect(() => setOpened(null), [props.treeId, compare]);
  const fallback = compare ? firstChangedTree(compare.trees) : (props.trees?.[0]?.id ?? null);
  const shown = [opened, props.treeId, fallback].find((id) => id && trees[id]) ?? null;
  const tree = shown ? trees[shown] : undefined;
  const liveMain = !compare && !!shown && shown === liveTreeId;

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const scope = `${compare ? "diff:" : ""}${shown}`;

  const select = useCallback(
    (path: string | null) => {
      setOwnSelection(path);
      onSelect?.(path);
    },
    [onSelect],
  );
  const openTree = useCallback(
    (id: string) => {
      if (!trees[id]) return;
      setOpened(id);
      select(null);
      onTreeChange?.(id);
    },
    [trees, select, onTreeChange],
  );

  const viewer = useMemo<ViewerContextValue>(
    () => ({
      useStatuses: (selector) => useStore(store, (s) => selector(s.statuses)),
      useSelected: (path) => useStore(store, (s) => s.selection === path),
      useMark: (treeId, uid) => diffMark(useStore(store, (s) => s.merged?.[treeId]?.marks.get(uid))),
      select,
      toggleExpanded: (path) =>
        setExpanded((e) => {
          const key = `${scope}|${path}`;
          const next = { ...e };
          if (next[key]) delete next[key];
          else next[key] = true;
          return next;
        }),
      windowAction: { label: "Open", run: openTree },
    }),
    [store, select, scope, openTree],
  );

  const items = useMemo(
    () =>
      tree
        ? layoutTree(tree, trees, {
            isExpanded: (p) => !!expanded[`${scope}|${p}`],
            dir,
            frameDecorator: decoratorFrames ? (n) => modelFor(n, models)?.category === "Decorator" : undefined,
            explain: explainEdges,
            ...(merged ? { linesFor: diffLinesFor(merged) } : {}),
          })
        : [],
    [tree, trees, expanded, scope, dir, decoratorFrames, models, explainEdges, merged],
  );
  const byPath = useMemo(() => new Map(items.map((i) => [i.path, i])), [items]);
  const boxFor = useMemo(() => boxesByPath(items), [items]);
  const problems = useMemo(() => (props.diagnostics ? problemsByNode(props.diagnostics) : undefined), [props.diagnostics]);
  const nodes = useMemo<BTFlowNode[]>(() => flowNodes(items, { models, dir, liveMain, selection, problems }), [items, models, dir, liveMain, selection, problems]);
  const edges = useMemo<BTFlowEdge[]>(
    () => flowEdges(items, { dir, liveMain, explain: explainEdges, ...(merged ? { edgeClass: diffEdgeClass(merged) } : {}) }),
    [items, dir, liveMain, explainEdges, merged],
  );

  const fit = useCallback(() => flow.fitView({ padding: 0.15, maxZoom: 1.1, duration: 200 }), [flow]);
  const reveal = useCallback(
    (path: string) => {
      const it = boxFor.get(path);
      if (!it) return;
      const r = nodeRect(it, dir);
      flow.setCenter(r.x + r.w / 2, r.y + r.h / 2, { zoom: Math.max(flow.getZoom(), 0.9), duration: 250 });
    },
    [boxFor, dir, flow],
  );
  useImperativeHandle(props.handle, () => ({ fit, reveal }), [fit, reveal]);

  // Refit when switching trees or layout direction.
  const lastFit = useRef("");
  useEffect(() => {
    const key = `${scope}|${dir}`;
    if (key === lastFit.current || !items.length) return;
    lastFit.current = key;
    requestAnimationFrame(fit);
  }, [scope, dir, items.length, fit]);

  if (!tree) return <div className="arbor-empty">No tree to show</div>;
  return (
    <ViewerContext.Provider value={viewer}>
      <ReactFlow<BTFlowNode, BTFlowEdge>
        className={dir === "LR" ? "lr" : ""}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        onNodeClick={(_, n) => select(byPath.get(n.id)?.window ? byPath.get(n.id)!.parentPath : n.id)}
        onNodeDoubleClick={(_, n) => {
          const it = byPath.get(n.id);
          if (it?.node.type === "SubTree" && it.node.attrs.ID) openTree(it.node.attrs.ID);
        }}
        onPaneClick={() => select(null)}
      >
        {props.background !== false && <Background gap={24} size={1} />}
        {props.controls !== false && <Controls showInteractive={false} />}
      </ReactFlow>
      {!tree.root && <div className="arbor-empty">{tree.id} is empty</div>}
    </ViewerContext.Provider>
  );
}
