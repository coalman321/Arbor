// What Arborist's node views (packages/arborist/src/react) read from the editor: its store, as the
// ViewerContext of the editing canvas and of the compare canvas.

import { diffMark, type ViewerContextValue } from "@coalman321/arborist/react";
import { showDiffTree, useDiffMark } from "./diff.ts";
import { openTree, select, toggleExpanded, useStore } from "./store.ts";

export const editorViewer: ViewerContextValue = {
  useStatuses: (selector) => useStore((s) => selector(s.live)),
  useSelected: (path) => useStore((s) => s.selection === path),
  useNodeClass: (path) => useStore((s) => (s.dropHint?.path === path ? `drop-${s.dropHint.zone}` : null)),
  select,
  toggleExpanded,
  onContextMenu: (e, path) => useStore.setState({ selection: path, menu: { x: e.clientX, y: e.clientY, path }, picker: null }),
  windowAction: {
    label: "Open to edit",
    title: (treeId, file) => `These steps belong to the tree "${treeId}" (${file}). Open it to change them.`,
    run: (treeId) => openTree(treeId),
  },
  editable: true,
};

export const diffViewer: ViewerContextValue = {
  useStatuses: (selector) => useStore((s) => selector(s.live)),
  useSelected: (path) => useStore((s) => s.diff?.selection === path),
  useMark: (treeId, uid) => diffMark(useDiffMark(treeId, uid)),
  select,
  toggleExpanded,
  windowAction: {
    label: "Show this tree",
    title: (treeId, file) => `These steps belong to the tree "${treeId}" (${file}).`,
    run: (treeId) => showDiffTree(treeId),
  },
};
