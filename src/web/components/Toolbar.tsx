import { useEffect, useRef, useState, type RefObject } from "react";
import { Logo } from "./Logo.tsx";
import { ProjectMenu } from "./ProjectUI.tsx";
import { closeReplay } from "../replay.ts";
import { closeCompare, openCompare } from "../diff.ts";
import { connectLive, disconnectLive, setPaused } from "../live.ts";
import { closeTab, localStorageSet, openTree, redo, saveAll, toggleFocus, togglePanel, undo, useStore, type Panels } from "../store.ts";

export function Toolbar() {
  const dirty = useStore((s) => Object.values(s.files).filter((f) => f.dirty).length);
  const canUndo = useStore((s) => !!(s.active && s.history[s.active]?.past.length));
  const canRedo = useStore((s) => !!(s.active && s.history[s.active]?.future.length));

  return (
    <header className="toolbar">
      <div className="app-brand" aria-label="Arbor">
        <Logo />
        <span>Arbor</span>
      </div>
      <ProjectMenu />
      <div className="toolbar-group">
        <button className={dirty ? "primary" : ""} disabled={!dirty} onClick={() => void saveAll()} title="Save all changed files (Ctrl+S)">
          Save{dirty ? ` (${dirty})` : ""}
        </button>
        <button disabled={!canUndo} onClick={() => undo()} title="Undo (Ctrl+Z)">
          ↶
        </button>
        <button disabled={!canRedo} onClick={() => redo()} title="Redo (Ctrl+Shift+Z)">
          ↷
        </button>
      </div>
      <FocusToggle />
      <CompareToggle />
      <div className="spacer" />
      <LiveControls />
      <SettingsMenu />
    </header>
  );
}

const PANEL_INFO: Record<keyof Panels, { icon: string; name: string; keys: string }> = {
  left: { icon: "◧", name: "trees and nodes list", keys: "Ctrl+B" },
  bottom: { icon: "⬓", name: "Problems / XML / Live log panel", keys: "Ctrl+J" },
  right: { icon: "◨", name: "properties panel", keys: "Ctrl+Alt+B" },
};

/** Focus mode: hide every panel around the canvas (each leaves an edge strip to bring it back). */
function FocusToggle() {
  const panels = useStore((s) => s.panels);
  const focused = !panels.left && !panels.bottom && !panels.right;
  return (
    <button
      className={focused ? "on" : ""}
      aria-pressed={focused}
      onClick={toggleFocus}
      title={focused ? "Bring the panels back (Ctrl+Shift+F)" : "Hide all panels to see just the tree (Ctrl+Shift+F)"}
    >
      {focused ? "Exit focus" : "Focus"}
    </button>
  );
}

/** Compare mode: the trees at two git revisions, as one tree with the differences marked. */
function CompareToggle() {
  const on = useStore((s) => !!s.diff);
  return (
    <button
      className={on ? "on" : ""}
      aria-pressed={on}
      onClick={() => (on ? closeCompare() : void openCompare())}
      title={on ? "Back to editing" : "Compare the trees between two git revisions"}
    >
      {on ? "Done comparing" : "Compare…"}
    </button>
  );
}

/** What's left of a hidden panel: a thin strip that brings it back. */
export function EdgeStrip({ side }: { side: keyof Panels }) {
  const label = side === "left" ? "Trees & nodes" : side === "right" ? "Properties" : "Problems · XML · Live log";
  const arrow = side === "left" ? "▸" : side === "right" ? "◂" : "▴";
  return (
    <button className={`edge-strip edge-${side}`} onClick={() => togglePanel(side)} title={`Show ${PANEL_INFO[side].name} (${PANEL_INFO[side].keys})`}>
      <span>{arrow}</span>
      <span className="edge-strip-label">{label}</span>
    </button>
  );
}

/** Close a popover on a click outside `ref` or on Escape. */
function useDismiss(open: boolean, setOpen: (open: boolean) => void, ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open, setOpen, ref]);
}

/** Display preferences, saved per browser. */
function SettingsMenu() {
  const dir = useStore((s) => s.layoutDir);
  const frames = useStore((s) => s.decoratorFrames);
  const explain = useStore((s) => s.explainEdges);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, setOpen, ref);
  const setDir = (next: "TB" | "LR") => {
    localStorageSet("bt-editor.layoutDir", next);
    useStore.setState({ layoutDir: next });
  };

  return (
    <div className="settings-menu" ref={ref}>
      <button className={`settings-button ${open ? "on" : ""}`} onClick={() => setOpen(!open)} title="Settings" aria-label="Settings" aria-haspopup="dialog" aria-expanded={open}>
        ⚙
      </button>
      {open && (
        <div className="popover settings-popover" role="dialog" aria-label="Settings">
          <div className="menu-section">Layout direction</div>
          <div className="setting-segmented" role="group" aria-label="Layout direction">
            <button className={dir === "TB" ? "on" : ""} aria-pressed={dir === "TB"} onClick={() => setDir("TB")}>
              ⇣ Top-down
            </button>
            <button className={dir === "LR" ? "on" : ""} aria-pressed={dir === "LR"} onClick={() => setDir("LR")}>
              ⇢ Left-right
            </button>
          </div>
          <div className="menu-section">Display</div>
          <label className="setting">
            <input
              type="checkbox"
              checked={frames}
              onChange={() => {
                localStorageSet("bt-editor.decoratorFrames", String(!frames));
                useStore.setState({ decoratorFrames: !frames });
              }}
            />
            <span>
              Decorator frames
              <div className="muted small-text">Draw Retry, Timeout, Inverter, ... as frames around their child instead of separate boxes</div>
            </span>
          </label>
          <label className="setting">
            <input
              type="checkbox"
              checked={explain}
              onChange={() => {
                localStorageSet("bt-editor.explainEdges", String(!explain));
                useStore.setState({ explainEdges: !explain });
              }}
            />
            <span>
              Explain connections
              <div className="muted small-text">Label every connection in plain words (hover a label for more)</div>
            </span>
          </label>
          <div className="menu-section">About</div>
          <button
            className="setting-link"
            onClick={() => {
              setOpen(false);
              useStore.setState({ dialog: { kind: "licenses" } });
            }}
          >
            Open-source licences…
          </button>
        </div>
      )}
    </div>
  );
}

/** Connection status in the toolbar; the URL and connect/disconnect live in its popover. */
function LiveControls() {
  const live = useStore((s) => s.live);
  const [url, setUrl] = useState(live.url);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const busy = live.state !== "idle";
  // The project's default URL arrives after the first render.
  useEffect(() => {
    if (!url && live.url) setUrl(live.url);
  }, [live.url, url]);
  useDismiss(open, setOpen, ref);

  const label: Record<typeof live.state, string> = {
    idle: "Offline",
    connecting: "Connecting…",
    connected: live.robot ? `Live · ${live.robot}` : "Live",
    disconnected: "Reconnecting…",
    error: "Error",
    replay: "Replaying a log",
  };
  const mismatches = live.state === "connected" ? (live.mapping?.mismatches ?? []) : [];

  return (
    <div className="live-controls" ref={ref}>
      {live.state === "connected" && (
        <button className={live.paused ? "on" : ""} onClick={() => setPaused(!live.paused)} title="Freeze the displayed statuses">
          {live.paused ? "Resume" : "Pause"}
        </button>
      )}
      <button className="live-status" onClick={() => setOpen(!open)} title={live.message ?? "Robot connection"} aria-haspopup="dialog" aria-expanded={open}>
        <span className={`live-dot state-${live.state}`} />
        <span className="live-label">{label[live.state]}</span>
        {mismatches.length > 0 && (
          <span className="badge badge-warning">
            {mismatches.length} mismatch{mismatches.length === 1 ? "" : "es"}
          </span>
        )}
        <span className="chevron">▾</span>
      </button>
      {open && (
        <div className="popover live-popover" role="dialog" aria-label="Robot connection">
          <div className="menu-section">Robot connection</div>
          {live.message && <p className="live-message muted small-text">{live.message}</p>}
          {live.state === "connected" && live.treeId && (
            <button
              className="link live-tree"
              onClick={() => {
                setOpen(false);
                openTree(live.treeId!);
              }}
              title="Open the tree the robot is running"
            >
              Running: <strong>{live.treeId}</strong>
            </button>
          )}
          {mismatches.length > 0 && (
            <ul className="live-mismatches small-text">
              {mismatches.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          )}
          <div className="live-connect">
            <input
              className="live-url mono"
              value={busy ? live.url : url}
              disabled={busy}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && connectLive(url)}
              placeholder="ws://robot:1670"
              aria-label="Robot WebSocket URL"
              autoFocus={!busy}
            />
            {live.state === "replay" ? (
              <button onClick={closeReplay} title="Stop replaying the log">
                Close log
              </button>
            ) : busy ? (
              <button onClick={disconnectLive}>Disconnect</button>
            ) : (
              <button className="primary" onClick={() => connectLive(url || live.url)}>
                Connect
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function Tabs() {
  const tabs = useStore((s) => s.tabs);
  const active = useStore((s) => s.active);
  const trees = useStore((s) => s.trees);
  const files = useStore((s) => s.files);
  const liveTree = useStore((s) => (s.live.state === "connected" || s.live.state === "replay" ? s.live.treeId : undefined));
  if (!tabs.length) return <div className="tabs" />;
  return (
    <div className="tabs" role="tablist">
      {tabs.map((id) => {
        const dirty = files[trees[id]?.file]?.dirty;
        return (
          <div
            key={id}
            role="tab"
            aria-selected={id === active}
            className={`tab ${id === active ? "active" : ""}`}
            onClick={() => openTree(id)}
            onAuxClick={(e) => e.button === 1 && closeTab(id)}
            title={trees[id]?.file}
          >
            {liveTree === id && <span className="live-dot state-connected small" title="Running on the robot" />}
            <span>{id}</span>
            {dirty && <span className="dirty-dot" />}
            <button
              className="tab-close"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(id);
              }}
              aria-label={`Close ${id}`}
              title="Close (Ctrl+W)"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
