// Drawing a comparison (../compare.ts): each node of a merged tree styled by its Mark.

import type { Mark, MergedTree } from "../diff_view.ts";
import { diffLines } from "../diff_view.ts";
import type { Line, LayoutItem } from "../layout.ts";
import type { BTNode } from "../model.ts";
import type { NodeMark } from "./context.ts";

// One NodeMark per Mark, so a node re-renders only when its mark changes.
const marks = new WeakMap<Mark, NodeMark>();

/** How a node with this Mark is drawn: diff-* classes and a tag saying what happened to it. */
export function diffMark(mark: Mark | undefined): NodeMark | undefined {
  if (!mark) return undefined;
  let m = marks.get(mark);
  if (!m) marks.set(mark, (m = { className: diffClass(mark), tag: diffTag(mark) }));
  return m;
}

/** CSS classes for a node's change. */
function diffClass(mark: Mark): string {
  return [mark.kind === "same" ? "" : `diff-${mark.kind}`, mark.edited ? "diff-edited" : "", mark.innerChange ? "diff-inner" : ""].join(" ");
}

/** What happened to a node, as the short tag on its corner. */
function diffTag(mark: Mark): string | null {
  let text: string | null;
  switch (mark.kind) {
    case "added":
      text = "added";
      break;
    case "removed":
      text = "removed";
      break;
    case "moved-away":
      text = "moved away";
      break;
    case "moved":
      text = mark.reordered ? "reordered" : "moved";
      break;
    case "changed":
      text = "edited";
      break;
    default:
      text = mark.nesting ?? (mark.innerChange ? "contents changed" : null);
  }
  return text && text + (mark.kind === "moved" && mark.edited ? " · edited" : "");
}

/** For flowEdges' edgeClass: edges into added/removed/moved nodes take their color. */
export function diffEdgeClass(merged: Record<string, MergedTree>): (item: LayoutItem) => string | undefined {
  return (i) => {
    const kind = i.window ? undefined : merged[i.treeId]?.marks.get(i.node.uid)?.kind;
    return kind && kind !== "same" ? `diff-${kind}` : undefined;
  };
}

/** For layoutTree's linesFor: edited nodes show their changed attributes, old and new. */
export function diffLinesFor(merged: Record<string, MergedTree>): (node: BTNode, treeId: string) => Line[] | undefined {
  return (n, treeId) => diffLines(n, merged[treeId]?.marks.get(n.uid));
}
