// Turns a layout (layoutTree()) into React Flow nodes and edges drawn by this package's views.

import { edgeHint } from "../edge_hints.ts";
import { categoryOf, type LayoutItem } from "../layout.ts";
import type { Diagnostic, NodeModel } from "../model.ts";
import { modelFor } from "../models.ts";
import { defKey } from "../status.ts";
import { BTEdge, type BTFlowEdge } from "./BTEdge.tsx";
import { BTNodeView, FrameView, WindowView, type BTFlowNode } from "./BTNodeView.tsx";

export const nodeTypes = { bt: BTNodeView, frame: FrameView, window: WindowView };
export const edgeTypes = { bt: BTEdge };

export type Problem = { severity: string; message: string };

/** Diagnostics about nodes, by defKey(treeId, nodeUid): what flowNodes() shows as badges. */
export function problemsByNode(diagnostics: Iterable<Diagnostic>): Map<string, Problem[]> {
  const m = new Map<string, Problem[]>();
  for (const d of diagnostics) {
    if (!d.nodeUid || !d.treeId) continue;
    const key = defKey(d.treeId, d.nodeUid);
    m.set(key, [...(m.get(key) ?? []), d]);
  }
  return m;
}

export interface FlowNodeOptions {
  models: Map<string, NodeModel>;
  dir: "TB" | "LR";
  /** The tree on screen is the one the robot runs, so statuses are per instance (see nodeStatus). */
  liveMain: boolean;
  selection?: string | null;
  problems?: Map<string, Problem[]>;
  draggable?: (item: LayoutItem) => boolean;
  /** Paths drawn above everything else, e.g. the group being dragged. */
  lifted?: ReadonlySet<string> | null;
}

export function flowNodes(items: LayoutItem[], opts: FlowNodeOptions): BTFlowNode[] {
  const { models, dir, liveMain, selection, problems, draggable, lifted } = opts;
  return items.map((item) => {
    // A folded condition's problems count toward the box that draws it.
    const foldedProblems: Record<string, string[]> = {};
    const own = [...(problems?.get(defKey(item.treeId, item.node.uid)) ?? [])];
    for (const p of item.foldedPaths) {
      const uid = p.split("/").pop()!;
      const list = problems?.get(defKey(item.treeId, uid));
      if (!list) continue;
      foldedProblems[uid] = list.map((d) => d.message);
      own.push(...list);
    }
    return {
      id: item.path,
      type: item.window ? "window" : item.frame ? "frame" : "bt",
      position: { x: item.x, y: item.y },
      // Frames sit behind the nodes they surround (outer behind inner), and only their header
      // takes the pointer, so the canvas can still be panned from inside one.
      zIndex: (item.frame ? item.frame.level : 1000) + (lifted?.has(item.path) ? 5000 : 0),
      ...(item.frame
        ? { dragHandle: item.window ? ".bt-window-header" : ".bt-frame-header", style: { pointerEvents: "none" as const } }
        : {}),
      data: {
        item,
        category: categoryOf(item.node, models),
        icon: modelFor(item.node, models)?.metadata?.icon,
        problems: own,
        foldedProblems,
        dir,
        liveMain,
      },
      draggable: draggable?.(item) ?? false,
      selected: item.path === selection,
    };
  });
}

export interface FlowEdgeOptions {
  dir: "TB" | "LR";
  liveMain: boolean;
  /** Label edges with what they mean ("then", "else", "1st", ...; see edgeHint). */
  explain?: boolean;
  /** Paths whose edges ignore the row's bus line, e.g. while being dragged. */
  unbussed?: ReadonlySet<string> | null;
  /** Extra CSS classes for the edge leading to `item` (see diffEdgeClass). */
  edgeClass?: (item: LayoutItem) => string | undefined;
}

export function flowEdges(items: LayoutItem[], opts: FlowEdgeOptions): BTFlowEdge[] {
  const { dir, liveMain, explain, unbussed, edgeClass } = opts;
  const byPath = new Map(items.map((i) => [i.path, i]));
  return (
    items
      // A frame's child is inside it; no edge.
      .filter((i) => i.parentPath && !byPath.get(i.parentPath)?.frame)
      .map((i) => {
        const hint = explain ? edgeHint(byPath.get(i.parentPath!)!.node, i.childIndex) : null;
        return {
          id: `${i.parentPath}->${i.path}`,
          source: i.parentPath!,
          target: i.path,
          type: "bt" as const,
          data: {
            childPath: i.path,
            childTree: i.treeId,
            childUid: i.node.uid,
            liveMain,
            label: hint?.label ?? i.edgeLabel,
            help: hint?.help,
            dir,
            bus: unbussed?.has(i.path) ? undefined : i.edgeBus,
            className: edgeClass?.(i),
          },
          selectable: false,
        };
      })
  );
}

/** The part of an item that is "the node": all of a box, or just a frame's header. */
export function nodeRect(item: LayoutItem, dir: "TB" | "LR"): { x: number; y: number; w: number; h: number } {
  if (!item.frame) return item;
  return dir === "TB" ? { x: item.x, y: item.y, w: item.w, h: item.frame.headerH } : { x: item.x, y: item.y, w: item.frame.headerW, h: item.h };
}

/** Items by path, with nodes drawn inside another (folded conditions) resolving to that box. */
export function boxesByPath(items: LayoutItem[]): Map<string, LayoutItem> {
  const m = new Map(items.map((i) => [i.path, i]));
  for (const i of items) for (const p of i.foldedPaths) m.set(p, i);
  return m;
}
