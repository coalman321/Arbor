import {
  Background,
  BaseEdge,
  EdgeLabelRenderer,
  Controls,
  getSmoothStepPath,
  ReactFlow,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type NodeChange,
  applyNodeChanges,
} from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { addNode, effectiveZone, moveExisting, nodeForPaletteId } from "../actions.ts";
import { modelFor } from "../../shared/validate.ts";
import { edgeHint } from "../edge_hints.ts";
import { categoryOf, layoutTree, type LayoutItem } from "../layout.ts";
import { openTree, select, statusClass, useDiagnostics, useModels, useStore } from "../store.ts";
import type { DropZone } from "../tree_ops.ts";
import { BTNodeView, FrameView, WindowView, type BTFlowNode } from "./BTNodeView.tsx";

export const PALETTE_MIME = "application/x-bt-node";

function pointerOf(e: MouseEvent | TouchEvent): { x: number; y: number } {
  const p = "touches" in e ? (e.touches[0] ?? e.changedTouches[0]) : e;
  return { x: p.clientX, y: p.clientY };
}

const nodeTypes = { bt: BTNodeView, frame: FrameView, window: WindowView };

type BTEdgeData = {
  childPath: string;
  childTree: string;
  childUid: string;
  liveMain: boolean;
  label?: string;
  /** Longer explanation of the label, shown on hover. */
  help?: string;
  dir: "TB" | "LR";
  bus?: number;
};

function BTEdgeImpl(props: EdgeProps<Edge<BTEdgeData>>) {
  const { data } = props;
  const info = useStore((s) =>
    data ? (data.liveMain ? s.live.statusByPath[data.childPath] : s.live.statusByDef[`${data.childTree}:${data.childUid}`]) : undefined,
  );
  // Turn on the row's shared bus line rather than halfway down this edge (see LayoutItem.edgeBus).
  const bus = data?.bus;
  const [path] = getSmoothStepPath({
    ...props,
    borderRadius: 10,
    ...(bus === undefined ? {} : data?.dir === "LR" ? { centerX: bus } : { centerY: bus }),
  });
  const status = statusClass(info);
  // Labels sit just above (or, left-right, just before) the child they lead to.
  const lr = data?.dir === "LR";
  return (
    <>
      <BaseEdge path={path} className={`bt-edge ${status}`} />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className={`bt-edge-label nodrag nopan ${status}`}
            title={data.help}
            style={{
              transform: lr
                ? `translate(-100%, -100%) translate(${props.targetX - 8}px, ${props.targetY - 3}px)`
                : `translate(-50%, -100%) translate(${props.targetX}px, ${props.targetY - 5}px)`,
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
const edgeTypes = { bt: memo(BTEdgeImpl) };

export function Canvas() {
  const active = useStore((s) => s.active);
  const trees = useStore((s) => s.trees);
  const expanded = useStore((s) => s.expanded);
  const dir = useStore((s) => s.layoutDir);
  const decoratorFrames = useStore((s) => s.decoratorFrames);
  const explain = useStore((s) => s.explainEdges);
  const selection = useStore((s) => s.selection);
  const liveTree = useStore((s) => (s.live.state === "connected" || s.live.state === "replay" ? s.live.treeId : undefined));
  const fitRequest = useStore((s) => s.fitRequest);
  const models = useModels();
  const diagnostics = useDiagnostics();
  const flow = useReactFlow();
  const tree = active ? trees[active] : undefined;
  const liveMain = !!tree && liveTree === tree.id;

  const items = useMemo(
    () =>
      tree
        ? layoutTree(tree, trees, {
            isExpanded: (p) => !!expanded[`${tree.id}|${p}`],
            dir,
            frameDecorator: decoratorFrames ? (n) => modelFor(n, models)?.category === "Decorator" : undefined,
            explain,
          })
        : [],
    [tree, trees, expanded, dir, decoratorFrames, models, explain],
  );
  const byPath = useMemo(() => new Map(items.map((i) => [i.path, i])), [items]);
  /** Every item drawn below (or inside) each item: what moves along when it is dragged. */
  const descendants = useMemo(() => {
    const kids = new Map<string, string[]>();
    for (const i of items) if (i.parentPath) kids.set(i.parentPath, [...(kids.get(i.parentPath) ?? []), i.path]);
    const all = (p: string): string[] => (kids.get(p) ?? []).flatMap((c) => [c, ...all(c)]);
    return (p: string) => all(p);
  }, [items]);
  /** True if (x, y) is over a SubTree's locked contents, which can't be edited from this tab. */
  const lockedAt = useCallback(
    (x: number, y: number) => items.some((i) => i.window && x >= i.x && x <= i.x + i.w && y >= i.y && y <= i.y + i.h),
    [items],
  );
  /** The part of an item that is "the node": all of a box, or just a frame's header. */
  const hitRect = useCallback(
    (i: LayoutItem) => (i.frame ? (dir === "TB" ? { ...i, h: i.frame.headerH } : { ...i, w: i.frame.headerW }) : i),
    [dir],
  );
  // Nodes drawn inside another node (folded conditions) resolve to the box that shows them.
  const boxFor = useMemo(() => {
    const m = new Map(byPath);
    for (const i of items) for (const p of i.foldedPaths) m.set(p, i);
    return m;
  }, [items, byPath]);

  const problems = useMemo(() => {
    const m = new Map<string, { severity: string; message: string }[]>();
    for (const d of diagnostics) {
      if (!d.nodeUid || !d.treeId) continue;
      const key = `${d.treeId}:${d.nodeUid}`;
      m.set(key, [...(m.get(key) ?? []), d]);
    }
    return m;
  }, [diagnostics]);

  // Dragging over a locked SubTree shows a not-allowed cursor.
  const [blocked, setBlocked] = useState(false);
  const dragStart = useRef<{ x: number; y: number; group: Map<string, { x: number; y: number }> } | null>(null);
  /** Paths moving with the node being dragged; their edges can't use the (fixed) row bus line. */
  const [dragging, setDragging] = useState<Set<string> | null>(null);

  const layoutNodes = useMemo<BTFlowNode[]>(
    () =>
      items.map((item) => {
        // A folded condition's problems count toward the box that draws it.
        const foldedProblems: Record<string, string[]> = {};
        const own = [...(problems.get(`${item.treeId}:${item.node.uid}`) ?? [])];
        for (const p of item.foldedPaths) {
          const uid = p.split("/").pop()!;
          const list = problems.get(`${item.treeId}:${uid}`);
          if (!list) continue;
          foldedProblems[uid] = list.map((d) => d.message);
          own.push(...list);
        }
        return { item, own, foldedProblems };
      }).map(({ item, own, foldedProblems }) => ({
        id: item.path,
        type: item.window ? "window" : item.frame ? "frame" : "bt",
        position: { x: item.x, y: item.y },
        // Frames sit behind the nodes they surround (outer behind inner), and only their header
        // takes the pointer, so the canvas can still be panned from inside one.
        // While dragging, the moving group is lifted above everything else.
        zIndex: (item.frame ? item.frame.level : 1000) + (dragging?.has(item.path) ? 5000 : 0),
        ...(item.frame
          ? { dragHandle: item.window ? ".bt-window-header" : ".bt-frame-header", style: { pointerEvents: "none" as const } }
          : {}),
        data: {
          item,
          category: categoryOf(item.node, models),
          problems: own,
          foldedProblems,
          dir,
          liveMain,
        },
        draggable: !item.readOnly && item.parentPath !== null,
        selected: item.path === selection,
      })),
    [items, models, problems, dir, liveMain, selection, dragging],
  );
  const edges = useMemo<Edge<BTEdgeData>[]>(
    () =>
      items
        // A frame's child is inside it; no edge.
        .filter((i) => i.parentPath && !byPath.get(i.parentPath)?.frame)
        .map((i) => {
          const hint = explain ? edgeHint(byPath.get(i.parentPath!)!.node, i.childIndex) : null;
          return { i, label: hint?.label ?? i.edgeLabel, help: hint?.help };
        })
        .map(({ i, label, help }) => ({
          id: `${i.parentPath}->${i.path}`,
          source: i.parentPath!,
          target: i.path,
          type: "bt",
          data: { childPath: i.path, childTree: i.treeId, childUid: i.node.uid, liveMain, label, help, dir, bus: dragging?.has(i.path) ? undefined : i.edgeBus },
          selectable: false,
        })),
    [items, byPath, liveMain, dir, explain, dragging],
  );

  // React Flow owns positions while dragging; the layout owns them otherwise.
  const [nodes, setNodes] = useState(layoutNodes);
  useEffect(() => setNodes(layoutNodes), [layoutNodes]);
  const onNodesChange = useCallback(
    (changes: NodeChange<BTFlowNode>[]) => setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== "select"), ns)),
    [],
  );

  // Refit when switching trees or when asked to (toolbar button / layout direction change).
  const lastFit = useRef<string>("");
  useEffect(() => {
    const key = `${active}|${fitRequest}|${dir}`;
    if (key === lastFit.current || !items.length) return;
    lastFit.current = key;
    requestAnimationFrame(() => flow.fitView({ padding: 0.15, maxZoom: 1.1, duration: 200 }));
  }, [active, fitRequest, dir, items.length, flow]);

  // Center the selection when it's set from elsewhere (problems list, live log).
  useEffect(() => {
    const onReveal = (e: Event) => {
      const found = boxFor.get((e as CustomEvent<string>).detail);
      const it = found && hitRect(found);
      if (it) flow.setCenter(it.x + it.w / 2, it.y + it.h / 2, { zoom: Math.max(flow.getZoom(), 0.9), duration: 250 });
    };
    window.addEventListener("bt-reveal", onReveal);
    return () => window.removeEventListener("bt-reveal", onReveal);
  }, [boxFor, hitRect, flow]);

  /** Where a drop at flow position (x, y) would go, ignoring `exclude` and its descendants. */
  const hitTest = useCallback(
    (x: number, y: number, exclude?: string): { item: LayoutItem; zone: DropZone } | null => {
      if (!tree?.root) return null;
      const excluded = (it: LayoutItem) => {
        for (let p: string | null = it.path; p; p = byPath.get(p)?.parentPath ?? null) if (p === exclude) return true;
        return false;
      };
      const hits = (i: LayoutItem) => {
        const r = hitRect(i);
        return !i.readOnly && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h && !excluded(i);
      };
      // Boxes win over the frame headers they might be stacked under.
      const it = items.find((i) => !i.frame && hits(i)) ?? items.find((i) => i.frame && hits(i));
      if (!it) return null;
      const r = hitRect(it);
      const rel = dir === "TB" ? (x - r.x) / r.w : (y - r.y) / r.h;
      const side: DropZone = rel < 0.5 ? "before" : "after";
      const wanted: DropZone = rel < 0.25 ? "before" : rel > 0.75 ? "after" : "inside";
      const zone = effectiveZone(tree.root, it.node, wanted, models) ?? (wanted === "inside" ? effectiveZone(tree.root, it.node, side, models) : null);
      return zone ? { item: it, zone } : null;
    },
    [tree, items, byPath, dir, models, hitRect],
  );


  const setHint = (h: { item: LayoutItem; zone: DropZone } | null) => {
    const cur = useStore.getState().dropHint;
    if (cur?.path === h?.item.path && cur?.zone === h?.zone) return;
    useStore.setState({ dropHint: h ? { path: h.item.path, zone: h.zone } : null });
  };

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(PALETTE_MIME)) return;
    e.preventDefault();
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const locked = lockedAt(p.x, p.y);
    e.dataTransfer.dropEffect = locked ? "none" : "copy";
    setHint(locked ? null : hitTest(p.x, p.y));
  };
  const onDrop = (e: DragEvent) => {
    const id = e.dataTransfer.getData(PALETTE_MIME);
    useStore.setState({ dropHint: null });
    if (!id || !tree) return;
    e.preventDefault();
    const p = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    if (lockedAt(p.x, p.y)) return;
    const hit = hitTest(p.x, p.y);
    addNode(tree.id, nodeForPaletteId(id), hit?.item.node.uid ?? null, hit?.zone ?? "inside");
  };

  if (!tree) {
    return (
      <div className="canvas-empty">
        <p>No tree open.</p>
        <p className="muted">Pick a tree on the left, or create one with “New tree”.</p>
      </div>
    );
  }

  return (
    <div className={`canvas ${blocked ? "drag-blocked" : ""}`} onDragOver={onDragOver} onDrop={onDrop} onDragLeave={() => setHint(null)}>
      <ReactFlow<BTFlowNode, Edge<BTEdgeData>>
        className={dir === "LR" ? "lr" : ""}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
        elevateNodesOnSelect={false}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        onNodeClick={(_, n) => select(byPath.get(n.id)?.window ? byPath.get(n.id)!.parentPath : n.id)}
        onNodeDoubleClick={(_, n) => {
          const it = byPath.get(n.id);
          if (it?.node.type === "SubTree" && it.node.attrs.ID && trees[it.node.attrs.ID]) openTree(it.node.attrs.ID);
        }}
        onPaneClick={() => useStore.setState({ selection: null, menu: null, picker: null })}
        onNodeContextMenu={(e, n) => {
          e.preventDefault();
          const path = byPath.get(n.id)?.window ? byPath.get(n.id)!.parentPath! : n.id;
          useStore.setState({ selection: path, menu: { x: e.clientX, y: e.clientY, path }, picker: null });
        }}
        onNodeDragStart={(_, n) => {
          select(n.id);
          // Remember where the dragged node's subtree started, so it can follow the pointer.
          const group = new Map<string, { x: number; y: number }>();
          for (const d of descendants(n.id)) {
            const it = byPath.get(d);
            if (it) group.set(d, { x: it.x, y: it.y });
          }
          dragStart.current = { x: n.position.x, y: n.position.y, group };
          setDragging(new Set([n.id, ...group.keys()]));
        }}
        onNodeDrag={(e, n) => {
          const p = flow.screenToFlowPosition(pointerOf(e));
          const locked = lockedAt(p.x, p.y);
          setBlocked(locked);
          setHint(locked ? null : hitTest(p.x, p.y, n.id));
          const start = dragStart.current;
          if (start?.group.size) {
            const dx = n.position.x - start.x;
            const dy = n.position.y - start.y;
            setNodes((ns) =>
              ns.map((m) => {
                const at = start.group.get(m.id);
                return at ? { ...m, position: { x: at.x + dx, y: at.y + dy } } : m;
              }),
            );
          }
        }}
        onNodeDragStop={(e, n) => {
          const p = flow.screenToFlowPosition(pointerOf(e));
          const hit = lockedAt(p.x, p.y) ? null : hitTest(p.x, p.y, n.id);
          dragStart.current = null;
          setDragging(null);
          setBlocked(false);
          useStore.setState({ dropHint: null });
          const it = byPath.get(n.id);
          const moved = hit && it && moveExisting(tree.id, it.node.uid, hit.item.node.uid, hit.zone);
          if (!moved) setNodes(layoutNodes); // snap back
        }}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      {!tree.root && (
        <div className="canvas-hint">
          <p>
            <strong>{tree.id}</strong> is empty.
          </p>
          <p className="muted">Drag a node here from the palette, or</p>
          <button
            className="primary"
            onClick={(e) => useStore.setState({ picker: { x: e.clientX, y: e.clientY, mode: "root", treeId: tree.id } })}
          >
            Add root node
          </button>
        </div>
      )}
    </div>
  );
}
