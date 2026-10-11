import { useState } from "react";
import { localStorageGet, localStorageSet, type Panels } from "../store.ts";

type Edge = keyof Panels;

/** Default and minimum size (px) of each edge panel, and where the dragged size is remembered. */
const SIZES: Record<Edge, { key: string; def: number; min: number }> = {
  left: { key: "bt-editor.sidebarWidth", def: 250, min: 170 },
  right: { key: "bt-editor.inspectorWidth", def: 330, min: 230 },
  bottom: { key: "bt-editor.bottomHeight", def: 230, min: 90 },
};
/** Room always left for the canvas when growing a panel. */
const CANVAS_MIN = 240;

export type PanelSizes = Record<Edge, number>;

function loadSize(edge: Edge): number {
  const v = Number(localStorageGet(SIZES[edge].key));
  return v > 0 ? v : SIZES[edge].def;
}

export function usePanelSizes(): [PanelSizes, (edge: Edge, size: number | null) => void] {
  const [sizes, setSizes] = useState<PanelSizes>(() => ({ left: loadSize("left"), right: loadSize("right"), bottom: loadSize("bottom") }));
  // null puts the panel back to its default size.
  const setSize = (edge: Edge, size: number | null) => setSizes((s) => ({ ...s, [edge]: size ?? SIZES[edge].def }));
  return [sizes, setSize];
}

/** A drag handle on the inner edge of a panel; dragging it resizes the panel, double-clicking resets it. */
export function PanelResizer({ edge, size, onResize }: { edge: Edge; size: number; onResize: (size: number | null) => void }) {
  const vertical = edge !== "bottom";
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    // The space the panel shares with the canvas: .main for the side panels, .center for the bottom one.
    const container = handle.parentElement!;
    const max = (vertical ? container.clientWidth : container.clientHeight) - CANVAS_MIN - (vertical ? otherSideWidth(container, edge) : 0);
    const start = vertical ? e.clientX : e.clientY;
    // Growing the left panel means dragging right; the right and bottom panels grow toward the start.
    const sign = edge === "left" ? 1 : -1;
    let last = size;
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add(vertical ? "resizing-col" : "resizing-row");
    const move = (ev: PointerEvent) => {
      const delta = ((vertical ? ev.clientX : ev.clientY) - start) * sign;
      last = Math.round(Math.max(SIZES[edge].min, Math.min(Math.max(SIZES[edge].min, max), size + delta)));
      onResize(last);
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing-col", "resizing-row");
      localStorageSet(SIZES[edge].key, String(last));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };
  return (
    <div
      className={`panel-resizer ${vertical ? "vertical" : "horizontal"}`}
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      aria-label="Resize the panel"
      title="Drag to resize · double-click to reset"
      onPointerDown={startResize}
      onDoubleClick={() => {
        onResize(null);
        localStorageSet(SIZES[edge].key, "");
      }}
    />
  );
}

/** Width taken by the panel (or folded strip) on the opposite side of .main. */
function otherSideWidth(main: HTMLElement, edge: Edge): number {
  const el = edge === "left" ? main.lastElementChild : main.firstElementChild;
  return el instanceof HTMLElement ? el.offsetWidth : 0;
}
