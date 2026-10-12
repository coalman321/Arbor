// Tidy-tree layout. BT XML has no coordinates and child order is execution order, so the editor
// always lays trees out itself: parents centered over their children, one row (or column) per depth.

import { RESERVED_ATTRS, type BTNode, type NodeModel, type TreeDef } from "./model.ts";
import { joinPath } from "./live_mapping.ts";
import { modelFor } from "./models.ts";
import { decoratorHint } from "./edge_hints.ts";

/**
 * A condition drawn inside its parent's box (the first child of IfThenElse/WhileDoElse, or
 * Precondition's script) instead of as a box of its own. Composite conditions keep their
 * structure: Inverter becomes "¬", Sequence "∧", Fallback "∨", anything else Type(...).
 */
export type CondPart =
  | { kind: "leaf"; path: string; node: BTNode; label: string; args: string; script?: boolean }
  | { kind: "not"; path: string; node: BTNode; child: CondPart }
  | { kind: "group"; path: string; node: BTNode; op: "∧" | "∨" | null; children: CondPart[] }
  | { kind: "script"; text: string };

export interface FoldedCondition {
  /** Keyword shown before it: "if" or "while". */
  keyword: string;
  part: CondPart;
}

/** A port or attribute line on a node. `old` and `change` are set when it is drawn in a diff. */
export interface Line {
  key: string;
  value: string;
  old?: string;
  change?: "added" | "removed" | "changed";
}

export interface LayoutItem {
  path: string;
  node: BTNode;
  /** Tree that defines this node (differs from the tab inside an expanded SubTree). */
  treeId: string;
  readOnly: boolean;
  parentPath: string | null;
  depth: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Port/remap lines shown on the node. */
  lines: Line[];
  hiddenLines: number;
  expanded?: boolean;
  condition?: FoldedCondition;
  /** Paths of the nodes drawn inside this one as its condition. */
  foldedPaths: string[];
  /** Label on the edge from the parent, e.g. "then"/"else". */
  edgeLabel?: string;
  /**
   * Set for a decorator drawn as a frame around its child: x/y/w/h are then the whole frame, and
   * headerW/headerH the size of the decorator's own content at its top (left, in LR layouts).
   */
  frame?: { headerW: number; headerH: number; level: number };
  /**
   * Set on the locked frame drawn around an expanded SubTree's contents. Its path is the SubTree
   * node's path + WINDOW_SUFFIX, and `node` is the SubTree node.
   */
  window?: { treeId: string; file: string };
  /**
   * Depth-axis coordinate (y for TB, x for LR) where the edge from the parent turns: the middle of
   * the gap above this item's row, shared by all siblings so edges never cut through frame headers.
   */
  edgeBus?: number;
  /** Index of this node in its parent's children (0 for a SubTree's inline content). */
  childIndex: number;
  /** Plain-language line shown in a frame header, saying what the decorator does. */
  hint?: string;
}

export const MAX_LINES = 4;
const GAP_BREADTH = 28;
const GAP_DEPTH = 56;

/**
 * Controls whose first child is a condition, with the labels of their children in order. The
 * condition is drawn inside the control's box; the other children are drawn as labeled branches.
 */
export const CONDITION_FIRST: Record<string, readonly string[]> = {
  IfThenElse: ["if", "then", "else"],
  WhileDoElse: ["while", "do", "else"],
};

/** Ports shown as the node's condition rather than as a port line. */
const CONDITION_PORT: Record<string, string> = { Precondition: "if" };

export function visibleAttrs(node: BTNode): Line[] {
  const condPort = CONDITION_PORT[node.type];
  return Object.entries(node.attrs)
    .filter(([k]) => !RESERVED_ATTRS.has(k) && k !== condPort)
    .map(([key, value]) => ({ key, value }));
}

/** A leaf's arguments as shown in a condition: its port values, or the script of a ScriptCondition. */
function leafArgs(node: BTNode): string {
  return visibleAttrs(node)
    .map((a) => a.value)
    .join(", ");
}

export function conditionPart(node: BTNode, prefix: string, folded: string[]): CondPart {
  const path = joinPath(prefix, node.uid);
  folded.push(path);
  if (node.type === "Inverter" && node.children.length === 1) {
    return { kind: "not", path, node, child: conditionPart(node.children[0], prefix, folded) };
  }
  if (node.type === "ScriptCondition") {
    return { kind: "leaf", path, node, label: node.attrs.code ?? "", args: "", script: true };
  }
  if (node.children.length === 0) {
    const label = node.type === "SubTree" ? (node.attrs.ID ?? "SubTree") : node.attrs.name || node.type;
    return { kind: "leaf", path, node, label, args: leafArgs(node) };
  }
  const op = /Sequence/.test(node.type) ? "∧" : /Fallback/.test(node.type) ? "∨" : null;
  return { kind: "group", path, node, op, children: node.children.map((c) => conditionPart(c, prefix, folded)) };
}

/** The condition as plain text, for sizing and tooltips. */
export function conditionText(part: CondPart, nested = false): string {
  switch (part.kind) {
    case "script":
      return part.text;
    case "leaf":
      return part.args ? `${part.label}(${part.args})` : part.label;
    case "not":
      return `¬${conditionText(part.child, true)}`;
    case "group": {
      const inner = part.children.map((c) => conditionText(c, true)).join(part.op ? ` ${part.op} ` : ", ");
      if (!part.op) return `${part.node.type}(${inner})`;
      return nested && part.children.length > 1 ? `(${inner})` : inner;
    }
  }
}

const COND_LINE_CHARS = 30;

function measure(node: BTNode, lines: Line[], shown: number, hasMore: boolean, condition?: FoldedCondition) {
  const title = node.type === "SubTree" ? (node.attrs.ID ?? "SubTree") : node.type;
  const name = node.attrs.name && node.attrs.name !== title ? node.attrs.name : "";
  let chars = Math.max(title.length * 1.15 + 4, name.length);
  for (const l of lines.slice(0, shown)) chars = Math.max(chars, (l.key.length + l.value.length + 2 + (l.old === undefined ? 0 : l.old.length + 3)) * 0.95);
  let condHeight = 0;
  if (condition) {
    const text = `${condition.keyword} ${conditionText(condition.part)}`;
    chars = Math.max(chars, Math.min(text.length, COND_LINE_CHARS + 4));
    condHeight = 12 + Math.max(1, Math.ceil(text.length / COND_LINE_CHARS)) * 21;
  }
  const w = Math.round(Math.min(300, Math.max(150, chars * 7.4 + 34)));
  const h = 40 + (name ? 16 : 0) + condHeight + (shown ? shown * 17 + 8 : 0) + (hasMore ? 15 : 0);
  return { w, h };
}

export interface LayoutOptions {
  isExpanded: (path: string) => boolean;
  dir: "TB" | "LR";
  /**
   * Decorators for which this returns true (and that have their child) are drawn as a frame around
   * the child's whole subtree instead of as a box above it.
   */
  frameDecorator?: (node: BTNode) => boolean;
  /** Describe decorators in plain words in their frame headers (and leave room for edge labels). */
  explain?: boolean;
  /** Replaces a node's port lines (a diff shows changed attributes, with their old values). */
  linesFor?: (node: BTNode, treeId: string) => Line[] | undefined;
}

export const WINDOW_SUFFIX = "@window";
const WINDOW_HEADER_H = 34;

// Frame geometry: gap between a frame's header and what it wraps, and padding on the other sides.
const FRAME_HEAD_GAP = 6;
const FRAME_SIDE = 10;
const FRAME_END = 10;
const HINT_LINE = 18;
// Left-right layouts put edge labels on the horizontal run into each node, so they need more room.
const LR_LABEL_ROOM = 70;

export function layoutTree(tab: TreeDef, trees: Record<string, TreeDef>, opts: LayoutOptions): LayoutItem[] {
  if (!tab.root) return [];
  const { isExpanded, dir } = opts;
  const gapDepth = GAP_DEPTH + (opts.explain && dir === "LR" ? LR_LABEL_ROOM : 0);
  const items: LayoutItem[] = [];
  // Breadth axis is x for top-down layouts, y for left-right; depth axis the other one.
  const bSize = (w: number, h: number) => (dir === "TB" ? w : h);
  const dSize = (w: number, h: number) => (dir === "TB" ? h : w);
  const setRect = (it: LayoutItem, b0: number, d0: number, bLen: number, dLen: number) => {
    if (dir === "TB") Object.assign(it, { x: b0, y: d0, w: bLen, h: dLen });
    else Object.assign(it, { x: d0, y: b0, w: dLen, h: bLen });
  };
  const bStart = (it: LayoutItem) => (dir === "TB" ? it.x : it.y);
  const dStart = (it: LayoutItem) => (dir === "TB" ? it.y : it.x);

  interface Box {
    item: LayoutItem;
    kids: Box[];
    /** For a framed decorator: the box of the child it surrounds. */
    inner?: Box;
    /** Extent along the breadth axis of this subtree, frames included. */
    span: number;
  }
  /** Depth-axis room the frames around a node need above it, by node. */
  const headroom = new Map<LayoutItem, number>();

  const build = (
    node: BTNode,
    tree: TreeDef,
    prefix: string,
    parentPath: string | null,
    depth: number,
    readOnly: boolean,
    stack: string[],
    chain: number,
    frameLevel: number,
    childIndex: number,
  ): Box => {
    const path = joinPath(prefix, node.uid);
    const lines = opts.linesFor?.(node, tree.id) ?? visibleAttrs(node);
    const shown = Math.min(lines.length, MAX_LINES);
    const foldedPaths: string[] = [];
    const branchLabels = CONDITION_FIRST[node.type];
    let condition: FoldedCondition | undefined;
    let branches = node.children;
    if (branchLabels && node.children.length > 0) {
      condition = { keyword: branchLabels[0], part: conditionPart(node.children[0], prefix, foldedPaths) };
      branches = node.children.slice(1);
    } else if (CONDITION_PORT[node.type]) {
      condition = { keyword: CONDITION_PORT[node.type], part: { kind: "script", text: node.attrs[CONDITION_PORT[node.type]] ?? "" } };
    }
    const framed = node.children.length === 1 && !!opts.frameDecorator?.(node);
    // Precondition's hint would only repeat the IF row below it.
    const hint = framed && opts.explain && !condition ? decoratorHint(node)?.label : undefined;
    const measured = measure(node, lines, shown, lines.length > shown, condition);
    const w = hint ? Math.max(measured.w, Math.min(300, hint.length * 7 + 40)) : measured.w;
    // An empty IfThenElse shows a "drop a condition here" row.
    const h = measured.h + (branchLabels && !condition ? 33 : 0) + (hint ? HINT_LINE : 0);
    const item: LayoutItem = {
      path,
      node,
      treeId: tree.id,
      readOnly,
      parentPath,
      depth,
      x: 0,
      y: 0,
      w,
      h,
      lines: lines.slice(0, shown),
      hiddenLines: lines.length - shown,
      condition,
      foldedPaths,
      childIndex,
      hint,
    };
    items.push(item);

    if (framed) {
      // The child takes this node's place in the row; the header sits above it inside the frame.
      item.frame = { headerW: w, headerH: h, level: frameLevel };
      const inner = build(node.children[0], tree, prefix, path, depth, readOnly, stack, chain + dSize(w, h) + FRAME_HEAD_GAP, frameLevel + 1, 0);
      return { item, kids: [], inner, span: Math.max(inner.span + 2 * FRAME_SIDE, bSize(w, h)) };
    }

    headroom.set(item, chain);
    let kids: Box[] = [];
    if (node.type === "SubTree") {
      const sub = trees[node.attrs.ID ?? ""];
      item.expanded = isExpanded(path);
      // stack guards against recursive SubTrees, which validation reports separately.
      if (item.expanded && sub?.root && !stack.includes(sub.id)) {
        // The subtree's nodes sit in a locked "window" frame, which is what the edge leads to.
        const label = `${sub.id} · from ${sub.file.split("/").pop()}`;
        const headerW = Math.round(Math.min(320, Math.max(220, label.length * 7.2 + 130)));
        const headerH = dir === "TB" ? WINDOW_HEADER_H : 74;
        const win: LayoutItem = {
          path: path + WINDOW_SUFFIX,
          node,
          treeId: tree.id,
          readOnly: true,
          parentPath: path,
          depth: depth + 1,
          x: 0,
          y: 0,
          w: headerW,
          h: headerH,
          lines: [],
          hiddenLines: 0,
          foldedPaths: [],
          childIndex: 0,
          frame: { headerW, headerH, level: frameLevel },
          window: { treeId: sub.id, file: sub.file },
        };
        items.push(win);
        const inner = build(sub.root, sub, path, win.path, depth + 1, true, [...stack, sub.id], dSize(headerW, headerH) + FRAME_HEAD_GAP, frameLevel + 1, 0);
        kids = [{ item: win, kids: [], inner, span: Math.max(inner.span + 2 * FRAME_SIDE, bSize(headerW, headerH)) }];
      }
    } else {
      const offset = node.children.length - branches.length;
      kids = branches.map((c, i) => build(c, tree, prefix, path, depth + 1, readOnly, stack, 0, frameLevel, i + offset));
      if (branchLabels && condition) kids.forEach((k, i) => (k.item.edgeLabel = branchLabels[i + 1]));
    }
    const kidsSpan = kids.reduce((sum, k) => sum + k.span, 0) + GAP_BREADTH * Math.max(0, kids.length - 1);
    return { item, kids, span: Math.max(bSize(w, h), kidsSpan) };
  };

  const root = build(tab.root, tab, "", null, 0, false, [tab.id], 0, 0, 0);

  // Every node of one depth shares a row (TB) or column (LR). A row starts with room for the
  // deepest stack of frame headers in it; its nodes all start below that.
  const head: number[] = [];
  const size: number[] = [];
  for (const [it, room] of headroom) head[it.depth] = Math.max(head[it.depth] ?? 0, room);
  for (const [it] of headroom) size[it.depth] = Math.max(size[it.depth] ?? 0, head[it.depth] + dSize(it.w, it.h));
  const rowStart: number[] = [0];
  for (let d = 1; d < size.length; d++) rowStart[d] = rowStart[d - 1] + size[d - 1] + gapDepth;

  const place = (b: Box, start: number) => {
    if (b.inner) {
      place(b.inner, start + (b.span - b.inner.span) / 2);
      return;
    }
    const kidsSpan = b.kids.reduce((sum, k) => sum + k.span, 0) + GAP_BREADTH * Math.max(0, b.kids.length - 1);
    let cursor = start + (b.span - kidsSpan) / 2;
    for (const k of b.kids) {
      place(k, cursor);
      cursor += k.span + GAP_BREADTH;
    }
    const own = bSize(b.item.w, b.item.h);
    setRect(b.item, start + b.span / 2 - own / 2, rowStart[b.item.depth] + head[b.item.depth], own, dSize(b.item.w, b.item.h));
  };
  place(root, 0);

  // Frames enclose everything their child's subtree occupies, so size them bottom-up.
  interface Extent {
    b0: number;
    b1: number;
    d1: number;
  }
  const finish = (b: Box, outermost: boolean): Extent => {
    if (b.item.parentPath !== null) b.item.edgeBus = rowStart[b.item.depth] - (dir === "LR" ? gapDepth - GAP_DEPTH / 2 : gapDepth / 2);
    if (b.inner) {
      const e = finish(b.inner, false);
      const { headerW, headerH } = b.item.frame!;
      // Outermost frames all start at the top of their row, so headers in a row line up; any
      // spare room goes between the header and what it wraps.
      const d0 = outermost ? rowStart[b.item.depth] : dStart(b.inner.item) - FRAME_HEAD_GAP - dSize(headerW, headerH);
      let b0 = e.b0 - FRAME_SIDE;
      let b1 = e.b1 + FRAME_SIDE;
      const headerB = bSize(headerW, headerH);
      if (b1 - b0 < headerB) {
        const c = (b0 + b1) / 2;
        b0 = c - headerB / 2;
        b1 = c + headerB / 2;
      }
      const d1 = e.d1 + FRAME_END;
      setRect(b.item, b0, d0, b1 - b0, d1 - d0);
      return { b0, b1, d1 };
    }
    const own = { b0: bStart(b.item), b1: bStart(b.item) + bSize(b.item.w, b.item.h), d1: dStart(b.item) + dSize(b.item.w, b.item.h) };
    for (const k of b.kids) {
      const e = finish(k, true);
      own.b0 = Math.min(own.b0, e.b0);
      own.b1 = Math.max(own.b1, e.b1);
      own.d1 = Math.max(own.d1, e.d1);
    }
    return own;
  };
  finish(root, true);
  return items;
}

/** Category of a node, for coloring. */
export function categoryOf(node: BTNode, models: Map<string, NodeModel>): string {
  return modelFor(node, models)?.category ?? "Unknown";
}
