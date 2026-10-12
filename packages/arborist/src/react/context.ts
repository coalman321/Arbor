// What the node and edge views need from whoever hosts them. The views never touch a store of their
// own: TreeViewer provides this from its internal state, and an editor (Arbor) from its own store,
// with hooks so each node subscribes only to what it shows.

import { createContext, useContext, type MouseEvent } from "react";
import type { Statuses } from "../status.ts";

/** Extra styling for a node, e.g. how it changed in a diff. */
export interface NodeMark {
  /** CSS classes added to the node (and to the condition tokens standing for it). */
  className?: string;
  /** Short tag shown on the node's corner. */
  tag?: string | null;
}

export interface ViewerContextValue {
  /** Selects from the current statuses; a hook, called during render. */
  useStatuses<T>(selector: (s: Statuses) => T): T;
  /** Whether the node or condition token at `path` is selected; a hook. */
  useSelected(path: string): boolean;
  /** Extra styling for a node; a hook. Its result must be stable while nothing changes. */
  useMark?(treeId: string, nodeUid: string): NodeMark | undefined;
  /** Extra CSS class for the node at `path`, e.g. while something is dragged over it; a hook. */
  useNodeClass?(path: string): string | null;
  select(path: string): void;
  toggleExpanded(path: string): void;
  /** Right-click on a condition token (nodes get React Flow's onNodeContextMenu). */
  onContextMenu?(e: MouseEvent, path: string): void;
  /** Button on an expanded SubTree's frame: its label, and what it does. Omitted: no button. */
  windowAction?: { label: string; title?: (treeId: string, file: string) => string; run(treeId: string): void };
  /** Shows the "drop a condition here" placeholder in an empty IfThenElse/WhileDoElse. */
  editable?: boolean;
}

export const ViewerContext = createContext<ViewerContextValue | null>(null);

export function useViewer(): ViewerContextValue {
  const ctx = useContext(ViewerContext);
  if (!ctx) throw new Error("Arborist node views need a <ViewerContext.Provider> (TreeViewer provides one)");
  return ctx;
}

const noMark = () => undefined;
const noClass = () => null;

export function useMark(ctx: ViewerContextValue, treeId: string, nodeUid: string): NodeMark | undefined {
  return (ctx.useMark ?? noMark)(treeId, nodeUid);
}

export function useNodeClass(ctx: ViewerContextValue, path: string): string | null {
  return (ctx.useNodeClass ?? noClass)(path);
}
