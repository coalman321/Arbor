import { useEffect, useState } from "react";
import { Logo } from "./Logo.tsx";
import { ProjectMenu } from "./ProjectUI.tsx";
import { pickLogFile } from "./ReplayBar.tsx";
import { closeReplay } from "../replay.ts";
import { connectLive, disconnectLive, setPaused } from "../live.ts";
import { closeTab, localStorageSet, openTree, redo, saveAll, toggleFocus, togglePanel, undo, useStore, type Panels } from "../store.ts";

export function Toolbar() {
  const dirty = useStore((s) => Object.values(s.files).filter((f) => f.dirty).length);
  const active = useStore((s) => s.active);
  const canUndo = useStore((s) => !!(s.active && s.history[s.active]?.past.length));
  const canRedo = useStore((s) => !!(s.active && s.history[s.active]?.future.length));
  const dir = useStore((s) => s.layoutDir);
  const frames = useStore((s) => s.decoratorFrames);
  const explain = useStore((s) => s.explainEdges);

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
      <div className="toolbar-group">
        <button
          disabled={!active}
          onClick={() => {
            const next = dir === "TB" ? "LR" : "TB";
            localStorageSet("bt-editor.layoutDir", next);
            useStore.setState({ layoutDir: next });
          }}
          title="Toggle layout direction"
        >
          {dir === "TB" ? "⇣ Top-down" : "⇢ Left-right"}
        </button>
        <button
          disabled={!active}
          className={frames ? "on" : ""}
          aria-pressed={frames}
          onClick={() => {
            localStorageSet("bt-editor.decoratorFrames", String(!frames));
            useStore.setState({ decoratorFrames: !frames });
          }}
          title="Draw decorators (Retry, Timeout, Inverter, ...) as frames around their child, or as separate boxes"
        >
          ⬚ Decorator frames
        </button>
        <button
          disabled={!active}
          className={explain ? "on" : ""}
          aria-pressed={explain}
          onClick={() => {
            localStorageSet("bt-editor.explainEdges", String(!explain));
            useStore.setState({ explainEdges: !explain });
          }}
          title="Label every connection in plain words (hover a label for more)"
        >
          Aa Explain
        </button>
        <button disabled={!active} onClick={() => useStore.setState((s) => ({ fitRequest: s.fitRequest + 1 }))} title="Fit tree to view (F)">
          ⤢ Fit
        </button>
      </div>
      <ViewToggles />
      <div className="spacer" />
      <LiveControls />
    </header>
  );
}

const PANEL_INFO: Record<keyof Panels, { icon: string; name: string; keys: string }> = {
  left: { icon: "◧", name: "trees and nodes list", keys: "Ctrl+B" },
  bottom: { icon: "⬓", name: "Problems / XML / Live log panel", keys: "Ctrl+J" },
  right: { icon: "◨", name: "properties panel", keys: "Ctrl+Alt+B" },
};

/** Show/hide buttons for the panels around the canvas, and focus mode (all hidden). */
function ViewToggles() {
  const panels = useStore((s) => s.panels);
  const focused = !panels.left && !panels.bottom && !panels.right;
  return (
    <div className="toolbar-group view-toggles" role="group" aria-label="Panels">
      {(Object.keys(PANEL_INFO) as (keyof Panels)[]).map((k) => (
        <button
          key={k}
          className={panels[k] ? "on" : ""}
          aria-pressed={panels[k]}
          onClick={() => togglePanel(k)}
          title={`${panels[k] ? "Hide" : "Show"} the ${PANEL_INFO[k].name} (${PANEL_INFO[k].keys})`}
        >
          {PANEL_INFO[k].icon}
        </button>
      ))}
      <button
        className={focused ? "on" : ""}
        aria-pressed={focused}
        onClick={toggleFocus}
        title={focused ? "Bring the panels back (Ctrl+Shift+F)" : "Hide all panels to see just the tree (Ctrl+Shift+F)"}
      >
        {focused ? "Exit focus" : "Focus"}
      </button>
    </div>
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

function LiveControls() {
  const live = useStore((s) => s.live);
  const [url, setUrl] = useState(live.url);
  const busy = live.state !== "idle";
  // The project's default URL arrives after the first render.
  useEffect(() => {
    if (!url && live.url) setUrl(live.url);
  }, [live.url, url]);

  const label: Record<typeof live.state, string> = {
    idle: "Offline",
    connecting: "Connecting…",
    connected: live.robot ? `Live · ${live.robot}` : "Live",
    disconnected: "Reconnecting…",
    error: "Error",
    replay: "Replaying a log",
  };
  const mismatches = live.mapping?.mismatches.length ?? 0;

  return (
    <div className="live-controls">
      <span className={`live-dot state-${live.state}`} title={live.message ?? label[live.state]} />
      <span className="live-label" title={live.message}>
        {label[live.state]}
        {live.state === "connected" && live.treeId && (
          <button className="link" onClick={() => openTree(live.treeId!)} title="Open the tree the robot is running">
            {" "}
            · {live.treeId}
          </button>
        )}
      </span>
      {live.state === "connected" && mismatches > 0 && (
        <span className="badge badge-warning" title={live.mapping!.mismatches.join("\n")}>
          {mismatches} mismatch{mismatches === 1 ? "" : "es"}
        </span>
      )}
      <input
        className="live-url mono"
        value={busy ? live.url : url}
        disabled={busy}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && connectLive(url)}
        placeholder="ws://robot:1670"
        aria-label="Robot WebSocket URL"
      />
      {live.state === "replay" ? (
        <button onClick={closeReplay} title="Stop replaying the log">
          Close log
        </button>
      ) : busy ? (
        <>
          {live.state === "connected" && (
            <button onClick={() => setPaused(!live.paused)} title="Freeze the displayed statuses">
              {live.paused ? "Resume" : "Pause"}
            </button>
          )}
          <button onClick={disconnectLive}>Disconnect</button>
        </>
      ) : (
        <>
          <button className="primary" onClick={() => connectLive(url || live.url)}>
            Connect
          </button>
          <button onClick={pickLogFile} title="Replay a BehaviorTree.CPP log file (.btlog); you can also drop one on the window">
            Replay log…
          </button>
        </>
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
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
