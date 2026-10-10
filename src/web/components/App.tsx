import { ReactFlowProvider } from "@xyflow/react";
import { useEffect } from "react";
import {
  canHaveMoreChildren,
  copySelected,
  deleteSelected,
  duplicateSelected,
  moveSelected,
  pasteIntoSelected,
  selectedNode,
} from "../actions.ts";
import { wsUrl } from "../api.ts";
import { dirtyCount, loadProject, reconcileWithDisk, redo, saveAll, toast, toggleFocus, togglePanel, undo, useStore } from "../store.ts";
import { BottomPanel } from "./BottomPanel.tsx";
import { Canvas } from "./Canvas.tsx";
import { Inspector } from "./Inspector.tsx";
import { ConflictBanner, ContextMenu, Dialogs, NodePicker, Toast } from "./Overlays.tsx";
import { ProjectMovedBanner, Welcome } from "./ProjectUI.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { ReplayBar } from "./ReplayBar.tsx";
import { openLogFile, pause, seek, step, togglePlay } from "../replay.ts";
import { EdgeStrip } from "./Toolbar.tsx";
import { Tabs, Toolbar } from "./Toolbar.tsx";

const mouse = { x: 300, y: 200 };

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
}

function onKeyDown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  // Save and the panel toggles work everywhere, including while typing in the inspector.
  if (mod && key === "s") {
    e.preventDefault();
    void saveAll();
    return;
  }
  const panelKey =
    mod && e.shiftKey && key === "f" ? "focus" : mod && e.altKey && key === "b" ? "right" : mod && !e.shiftKey && key === "b" ? "left" : mod && key === "j" ? "bottom" : null;
  if (panelKey) {
    e.preventDefault();
    if (panelKey === "focus") toggleFocus();
    else togglePanel(panelKey);
    return;
  }
  const s = useStore.getState();
  if (isTyping(e) || s.dialog || s.picker) return;
  // Playback keys while a log is open.
  if (s.replay && !mod) {
    const r = s.replay;
    const keys: Record<string, () => void> = {
      " ": togglePlay,
      ArrowLeft: () => (e.shiftKey ? (pause(), seek(r.t - 1000)) : step(-1)),
      ArrowRight: () => (e.shiftKey ? (pause(), seek(r.t + 1000)) : step(1)),
      Home: () => (pause(), seek(0)),
      End: () => (pause(), seek(r.duration)),
    };
    if (keys[e.key] && !e.altKey) {
      e.preventDefault();
      keys[e.key]();
      return;
    }
  }
  let handled = true;
  if (mod && key === "z" && !e.shiftKey) undo();
  else if (mod && ((key === "z" && e.shiftKey) || key === "y")) redo();
  else if (mod && key === "c") copySelected();
  else if (mod && key === "x") copySelected(true);
  else if (mod && key === "v") pasteIntoSelected();
  else if (mod && key === "d") duplicateSelected();
  else if (e.altKey && e.key === "ArrowUp") moveSelected(-1);
  else if (e.altKey && e.key === "ArrowDown") moveSelected(1);
  else if (!mod && (e.key === "Delete" || e.key === "Backspace")) deleteSelected();
  else if (!mod && key === "f") useStore.setState({ fitRequest: s.fitRequest + 1 });
  else if (!mod && key === "a" && s.active) {
    const tree = s.trees[s.active];
    const sel = selectedNode();
    if (!tree.root) useStore.setState({ picker: { ...mouse, mode: "root", treeId: tree.id } });
    else if (sel && canHaveMoreChildren(sel.node)) useStore.setState({ picker: { ...mouse, mode: "child", treeId: tree.id, uid: sel.node.uid } });
    else if (sel) useStore.setState({ picker: { ...mouse, mode: "after", treeId: tree.id, uid: sel.node.uid } });
    else toast("Select a node first");
  } else if (e.key === "Escape") useStore.setState({ selection: null, menu: null });
  else handled = false;
  if (handled) e.preventDefault();
}

function useFileEvents() {
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stopped = false;
    let retry: number | null = null;
    const connect = () => {
      ws = new WebSocket(wsUrl("/api/events"));
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data as string);
        if (msg.op === "files_changed") void reconcileWithDisk().catch((e) => toast(`Reload failed: ${e.message}`, "error"));
        if (msg.op === "project_changed") {
          const s = useStore.getState();
          if (s.status === "ready" && msg.root === s.root) return; // our own switch
          // Follow another window's switch, unless that would throw away unsaved edits.
          if (s.status !== "ready" || dirtyCount() === 0) void loadProject();
          else useStore.setState({ projectMoved: { to: msg.root } });
        }
      };
      ws.onclose = () => {
        if (!stopped) retry = window.setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry !== null) clearTimeout(retry);
      ws?.close();
    };
  }, []);
}

export function App() {
  const status = useStore((s) => s.status);
  const loadError = useStore((s) => s.loadError);
  const panels = useStore((s) => s.panels);
  useFileEvents();
  useEffect(() => {
    void loadProject();
    const move = (e: MouseEvent) => {
      mouse.x = e.clientX;
      mouse.y = e.clientY;
    };
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyCount() > 0) e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    // Dropping a .btlog anywhere on the window plays it.
    const dragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      const file = [...(e.dataTransfer?.files ?? [])].find((f) => f.name.endsWith(".btlog"));
      if (!file) return;
      e.preventDefault();
      void openLogFile(file);
    };
    window.addEventListener("dragover", dragOver);
    window.addEventListener("drop", drop);
    window.addEventListener("mousemove", move);
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("dragover", dragOver);
      window.removeEventListener("drop", drop);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  if (status === "loading") return <div className="splash">Loading project…</div>;
  if (status === "none") return <Welcome />;
  if (status === "error")
    return (
      <div className="splash">
        <h2>Couldn't load the project</h2>
        <pre>{loadError}</pre>
        <button onClick={() => void loadProject()}>Retry</button>
      </div>
    );

  return (
    <ReactFlowProvider>
      <div className="app">
        <Toolbar />
        <ProjectMovedBanner />
        <ConflictBanner />
        <div className="main">
          {panels.left ? <Sidebar /> : <EdgeStrip side="left" />}
          <div className="center">
            <Tabs />
            <Canvas />
            <ReplayBar />
            {panels.bottom ? <BottomPanel /> : <EdgeStrip side="bottom" />}
          </div>
          {panels.right ? <Inspector /> : <EdgeStrip side="right" />}
        </div>
        <ContextMenu />
        <NodePicker />
        <Dialogs />
        <Toast />
      </div>
    </ReactFlowProvider>
  );
}
