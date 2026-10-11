// Opening and creating projects, and bringing tree files into one: the project menu in the toolbar,
// the welcome screen shown when no project is open, and the folder/file browser they share.

import { useEffect, useRef, useState } from "react";
import type { BrowseResult, WorkspaceInfo } from "../../shared/model.ts";
import { api } from "../api.ts";
import { useDismiss } from "../dismiss.ts";
import { pickLogFile } from "./ReplayBar.tsx";
import { Logo } from "./Logo.tsx";
import {
  confirmDiscard,
  importTreeFile,
  loadProject,
  reclaimProject,
  switchProject,
  useStore,
  type BrowseMode,
  type DialogState,
} from "../store.ts";

function parentOf(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

function useWorkspace(): [WorkspaceInfo | null, () => void] {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const reload = () => void api.workspace().then(setInfo, () => setInfo(null));
  useEffect(reload, []);
  return [info, reload];
}

async function openRecent(path: string) {
  if (!confirmDiscard("Open another project")) return;
  const err = await switchProject(path);
  if (err) alert(err);
}

const TITLES: Record<BrowseMode, string> = {
  openProject: "Open a project",
  newProject: "Create a new project",
  importTree: "Add a tree file to this project",
};

const HELP: Record<BrowseMode, string> = {
  openProject: "Pick a project folder: one with a bt_project.json, or a nodes.xml next to a trees folder.",
  newProject: "Pick the folder to create the project in, and give it a name. It gets a nodes.xml and a trees folder with one empty tree.",
  importTree: "Pick a BehaviorTree.CPP .xml file. It is copied into this project's trees folder; the original isn't changed.",
};

export function BrowseDialog({ mode, close }: { mode: BrowseMode; close: () => void }) {
  const root = useStore((s) => s.root);
  const [info] = useWorkspace();
  const [listing, setListing] = useState<BrowseResult | null>(null);
  const [typed, setTyped] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState("my_robot_trees");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only the latest navigation wins, so a slow first load can't override where the user went.
  const navSeq = useRef(0);
  const pathInput = useRef<HTMLInputElement>(null);
  // Long paths: keep the current folder's name (the end) in view.
  useEffect(() => {
    const el = pathInput.current;
    if (el && document.activeElement !== el) el.scrollLeft = el.scrollWidth;
  }, [listing]);
  const go = async (path?: string) => {
    const seq = ++navSeq.current;
    try {
      const r = await api.browse(path);
      if (seq !== navSeq.current) return;
      setListing(r);
      setTyped(r.path);
      setSelected(null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  // Start next to the open project (or in it, when importing), else in the home directory.
  const started = useRef(false);
  useEffect(() => {
    if (!info || started.current || navSeq.current > 0) return;
    started.current = true;
    const start = root ? (mode === "importTree" ? root : parentOf(root)) : info.home;
    void go(start).then(() => undefined);
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  const join = (a: string, b: string) => `${a.replace(/\/+$/, "")}/${b}`;
  const target =
    mode === "newProject" ? (listing && name ? join(listing.path, name) : null) : selected ?? (mode === "openProject" && listing?.isProject ? listing.path : null);
  const nameOk = /^[A-Za-z0-9_.-]+$/.test(name);

  const submit = async () => {
    if (!target) return;
    if (mode !== "importTree" && !confirmDiscard(mode === "newProject" ? "Create a new project" : "Open another project")) return;
    setBusy(true);
    const err = mode === "importTree" ? await importTreeFile(target) : await switchProject(target, mode === "newProject");
    setBusy(false);
    if (err) setError(err);
    else close();
  };

  const entries = listing?.entries.filter((e) => e.kind === "dir" || mode === "importTree") ?? [];
  const submitLabel =
    mode === "newProject" ? "Create project" : mode === "importTree" ? "Add to project" : target ? `Open ${target.split("/").pop()}` : "Open";

  return (
    <form
      className="browse"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>{TITLES[mode]}</h3>
      <p className="muted">{HELP[mode]}</p>
      <div className="row">
        <button type="button" disabled={!listing?.parent} onClick={() => void go(listing!.parent!)} title="Up one folder">
          ↑ Up
        </button>
        <input
          ref={pathInput}
          className="mono"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void go(typed);
            }
          }}
          aria-label="Folder"
        />
        {info && (
          <button type="button" onClick={() => void go(info.home)} title={info.home}>
            ⌂
          </button>
        )}
      </div>
      <div className="browse-list" role="listbox">
        {listing?.isProject && mode === "openProject" && (
          <div className="browse-note">▣ This folder is a project. Press Open, or pick another one below.</div>
        )}
        {entries.map((e) => {
          const full = join(listing!.path, e.name);
          const isSel = selected === full;
          const choosable = (mode === "openProject" && e.isProject) || (mode === "importTree" && e.kind === "xml");
          return (
            <div
              key={e.name}
              role="option"
              aria-selected={isSel}
              className={`browse-entry ${isSel ? "selected" : ""} ${e.kind}`}
              onClick={() => (choosable ? setSelected(full) : e.kind === "dir" ? void go(full) : undefined)}
              onDoubleClick={() => (e.kind === "dir" && !(mode === "openProject" && e.isProject) ? void go(full) : choosable && void submit())}
              title={choosable ? "Click to pick, double-click to " + (mode === "importTree" ? "add" : "open") : "Click to go into this folder"}
            >
              <span className="browse-icon">{e.kind === "xml" ? "🗎" : e.isProject ? "▣" : "📁"}</span>
              <span className="browse-name">{e.name}</span>
              {e.isProject && <span className="chip">project</span>}
              {e.kind === "dir" && choosable && (
                <button
                  type="button"
                  className="small"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    void go(full);
                  }}
                >
                  Look inside
                </button>
              )}
            </div>
          );
        })}
        {listing && entries.length === 0 && (
          <p className="muted pad">{mode === "importTree" ? "No folders or .xml files here." : "No folders here."}</p>
        )}
      </div>
      {mode === "newProject" && (
        <label className="field">
          <span className="field-label">Project name (becomes a new folder here)</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          {target && <span className="field-help mono">{target}</span>}
        </label>
      )}
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions">
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!target || busy || (mode === "newProject" && !nameOk)}>
          {busy ? "Working…" : submitLabel}
        </button>
      </div>
    </form>
  );
}

/** The project name in the toolbar, opening a menu of project and file actions. */
export function ProjectMenu() {
  const manifest = useStore((s) => s.manifest);
  const root = useStore((s) => s.root);
  const [open, setOpen] = useState(false);
  const [info, reload] = useWorkspace();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (open) reload();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useDismiss(ref, () => setOpen(false), open);
  const dialog = (d: { dialog: DialogState }) => {
    setOpen(false);
    useStore.setState(d);
  };
  const recent = info?.recent.filter((r) => r.path !== root && r.exists) ?? [];

  return (
    <div className="project-menu" ref={ref}>
      <button className="brand" onClick={() => setOpen(!open)} title={root} aria-haspopup="menu" aria-expanded={open}>
        <Logo /> {manifest?.name ?? "Arbor"} <span className="chevron">▾</span>
      </button>
      {open && (
        <div className="menu project-dropdown" role="menu">
          <div className="menu-section">Trees</div>
          <button onClick={() => dialog({ dialog: { kind: "newTree" } })}>New tree…</button>
          <button onClick={() => dialog({ dialog: { kind: "browse", mode: "importTree" } })}>Add a tree file…</button>
          <hr />
          <div className="menu-section">Logs</div>
          <button
            onClick={() => {
              setOpen(false);
              pickLogFile();
            }}
          >
            Replay a log file (.btlog)…
          </button>
          <hr />
          <div className="menu-section">Projects</div>
          <button onClick={() => dialog({ dialog: { kind: "browse", mode: "newProject" } })}>New project…</button>
          <button onClick={() => dialog({ dialog: { kind: "browse", mode: "openProject" } })}>Open project…</button>
          {recent.length > 0 && (
            <>
              <div className="menu-section">Recent</div>
              {recent.slice(0, 6).map((r) => (
                <button
                  key={r.path}
                  title={r.path}
                  onClick={() => {
                    setOpen(false);
                    void openRecent(r.path);
                  }}
                >
                  ▣ {r.name}
                  <span className="muted small-text recent-path">{r.path}</span>
                </button>
              ))}
            </>
          )}
          <hr />
          <div className="muted small-text menu-footer mono" title={root}>
            {root}
          </div>
        </div>
      )}
    </div>
  );
}

/** Shown when the backend has no project open. */
export function Welcome() {
  const [info, reload] = useWorkspace();
  const dialog = useStore((s) => s.dialog);
  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1>
          <Logo /> Arbor
        </h1>
        <p className="muted">The behavior tree editor. Open a project to start, or make a new one.</p>
        <div className="row welcome-actions">
          <button className="primary" onClick={() => useStore.setState({ dialog: { kind: "browse", mode: "newProject" } })}>
            New project…
          </button>
          <button onClick={() => useStore.setState({ dialog: { kind: "browse", mode: "openProject" } })}>Open project…</button>
        </div>
        {info && info.recent.length > 0 && (
          <>
            <h4 className="section-title">Recent projects</h4>
            <ul className="recent-list">
              {info.recent.map((r) => (
                <li key={r.path} className={r.exists ? "" : "missing"}>
                  <button className="recent-open" disabled={!r.exists} onClick={() => void openRecent(r.path)} title={r.path}>
                    <strong>▣ {r.name}</strong>
                    <span className="muted small-text mono">{r.path}</span>
                    {!r.exists && <span className="badge badge-warning">missing</span>}
                  </button>
                  <button
                    className="icon-button"
                    title="Remove from this list"
                    onClick={() => void api.forgetRecent(r.path).then(reload)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
      {dialog?.kind === "browse" && (
        <div className="modal-backdrop">
          <div className="modal browse-modal" role="dialog">
            <BrowseDialog mode={dialog.mode} close={() => useStore.setState({ dialog: null })} />
          </div>
        </div>
      )}
    </div>
  );
}

/** Another window switched the backend to a different project: saving here would go astray. */
export function ProjectMovedBanner() {
  const moved = useStore((s) => s.projectMoved);
  const name = useStore((s) => s.manifest?.name);
  if (!moved) return null;
  return (
    <div className="banner">
      <div className="row">
        <span>
          Another window switched the editor to {moved.to ? <strong>{moved.to.split("/").pop()}</strong> : "no project"}. This window
          can't save to <strong>{name}</strong> until you reopen it.
        </span>
        <div className="spacer" />
        <button onClick={() => void reclaimProject()}>Reopen {name}</button>
        <button
          onClick={() => {
            if (confirmDiscard("Follow the other window")) void loadProject();
          }}
        >
          Follow the other window
        </button>
      </div>
    </div>
  );
}
