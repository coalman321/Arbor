import { useEffect, useRef, type RefObject } from "react";

/**
 * Closes a popup on a press outside `ref` or on Escape, while `active`. Listens in the capture
 * phase: the canvas (React Flow's pan and zoom) stops presses from bubbling up to the window.
 */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void, active = true) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!active) return;
    const down = (e: PointerEvent) => ref.current && !ref.current.contains(e.target as Node) && close.current();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close.current();
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [ref, active]);
}
