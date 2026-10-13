import { useEffect, useMemo, useRef, useState } from "react";
import {
  allowedChildren,
  CONDITION_FIRST,
  ICON_CHOICES,
  iconFor,
  NODE_CATEGORIES,
  type NodeCategory,
  type NodeModel,
  type PortDirection,
  type PortModel,
} from "@coalman321/arborist";
import type { AboutInfo, BundledGitInfo, LibraryLicense } from "../../shared/model.ts";
import { api, libraryLicenses } from "../api.ts";
import { useDismiss } from "../dismiss.ts";
import {
  addNode,
  canHaveMoreChildren,
  copySelected,
  deleteSelected,
  duplicateSelected,
  extractToSubtree,
  moveSelected,
  nodeForPaletteId,
  pasteIntoSelected,
  replaceSelected,
  unwrapSelected,
  wrapSelected,
} from "../actions.ts";
import {
  createTree,
  fileNameFor,
  moveTreeToFile,
  openTree,
  renameTree,
  resolveConflict,
  resolvePath,
  saveSpecModel,
  toggleExpanded,
  useModels,
  useStore,
} from "../store.ts";
import { findIn } from "../tree_ops.ts";
import { BrowseDialog } from "./ProjectUI.tsx";

/** Keeps a popup at (x, y) inside the viewport. */
function clampStyle(x: number, y: number, w: number, h: number): React.CSSProperties {
  return { left: Math.max(8, Math.min(x, window.innerWidth - w - 8)), top: Math.max(8, Math.min(y, window.innerHeight - h - 8)) };
}

export function ContextMenu() {
  const menu = useStore((s) => s.menu);
  const trees = useStore((s) => s.trees);
  const active = useStore((s) => s.active);
  const clipboard = useStore((s) => s.clipboard);
  const models = useModels();
  const ref = useRef<HTMLDivElement>(null);
  const close = () => useStore.setState({ menu: null });
  useDismiss(ref, close);
  if (!menu || !active) return null;
  const r = resolvePath(trees, active, menu.path);
  if (!r) return null;
  const { node, readOnly } = r;
  const isRoot = trees[active].root?.uid === node.uid;
  const picker = (mode: "child" | "after" | "wrap" | "replace") =>
    useStore.setState({ menu: null, picker: { x: menu.x, y: menu.y, mode, treeId: active, uid: node.uid } });
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  const isSubTree = node.type === "SubTree";
  const target = isSubTree ? trees[node.attrs.ID ?? ""] : undefined;

  return (
    <div className="menu" ref={ref} style={clampStyle(menu.x, menu.y, 220, 380)} role="menu">
      {isSubTree && target && <button onClick={run(() => openTree(target.id))}>Open {target.id}</button>}
      {isSubTree && target && <button onClick={run(() => toggleExpanded(menu.path))}>Toggle inline view</button>}
      {readOnly ? (
        <>
          <button onClick={run(() => openTree(r.tree.id, node.uid))}>Open {r.tree.id} to edit</button>
          <button onClick={run(() => copySelected())}>Copy</button>
        </>
      ) : (
        <>
          {isSubTree && <hr />}
          <button disabled={!canHaveMoreChildren(node, models)} onClick={() => picker("child")}>
            Add child… <kbd>A</kbd>
          </button>
          <button disabled={isRoot} onClick={() => picker("after")}>
            Add sibling after…
          </button>
          <button onClick={() => picker("wrap")}>Wrap in…</button>
          <button onClick={() => picker("replace")}>Change type…</button>
          <hr />
          <button disabled={isRoot} onClick={run(() => moveSelected(-1))}>
            Move up <kbd>Alt+↑</kbd>
          </button>
          <button disabled={isRoot} onClick={run(() => moveSelected(1))}>
            Move down <kbd>Alt+↓</kbd>
          </button>
          <hr />
          <button onClick={run(() => copySelected())}>
            Copy <kbd>Ctrl+C</kbd>
          </button>
          <button onClick={run(() => copySelected(true))}>
            Cut <kbd>Ctrl+X</kbd>
          </button>
          <button disabled={!clipboard} onClick={run(pasteIntoSelected)}>
            Paste <kbd>Ctrl+V</kbd>
          </button>
          <button disabled={isRoot} onClick={run(duplicateSelected)}>
            Duplicate <kbd>Ctrl+D</kbd>
          </button>
          <hr />
          <button
            onClick={run(() => useStore.setState({ dialog: { kind: "newTree", extractFrom: { treeId: active, uid: node.uid } } }))}
          >
            Extract to SubTree…
          </button>
          {node.children.length > 0 && <button onClick={run(unwrapSelected)}>Unwrap (keep children)</button>}
          <button className="danger" onClick={run(deleteSelected)}>
            Delete <kbd>Del</kbd>
          </button>
        </>
      )}
    </div>
  );
}

const PICKER_TITLES = {
  child: "Add child",
  after: "Add sibling after",
  wrap: "Wrap in",
  replace: "Change type to",
  root: "Add root node",
};

/** "Add child", or for IfThenElse/WhileDoElse, which part the new child becomes. */
function pickerTitle(picker: NonNullable<ReturnType<typeof useStore.getState>["picker"]>): string {
  if (picker.mode === "child" && picker.uid) {
    const root = useStore.getState().trees[picker.treeId]?.root;
    const parent = root ? findIn(root, picker.uid) : null;
    const labels = parent && CONDITION_FIRST[parent.type];
    const next = labels?.[parent!.children.length];
    if (next) return next === labels[0] ? "Add condition" : `Add ${next}-branch`;
  }
  return PICKER_TITLES[picker.mode];
}

/** Searchable list of node types; Enter picks the highlighted one. */
export function NodePicker() {
  const picker = useStore((s) => s.picker);
  const models = useModels();
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => useStore.setState({ picker: null });
  useDismiss(ref, close);
  useEffect(() => {
    setQ("");
    setIndex(0);
  }, [picker]);

  const options = useMemo(() => {
    if (!picker) return [];
    const all = [...models.values()].filter((m) => !(m.id === "SubTree" && m.source === "builtin"));
    // Wrapping needs a node that can take a child.
    const usable =
      picker.mode === "wrap"
        ? all.filter((m) => allowedChildren(nodeForPaletteId(m.category === "SubTree" ? `SubTree:${m.id}` : m.id), models)[1] >= 1)
        : all;
    const f = q.trim().toLowerCase();
    const scored = usable
      .map((m) => {
        const id = m.id.toLowerCase();
        const score = !f ? 1 : id === f ? 100 : id.startsWith(f) ? 50 : id.includes(f) ? 20 : (m.description ?? "").toLowerCase().includes(f) ? 5 : 0;
        return { m, score: score + (m.source === "spec" ? 2 : 0) };
      })
      .filter((x) => x.score > 0);
    scored.sort((a, b) => b.score - a.score || NODE_CATEGORIES.indexOf(a.m.category) - NODE_CATEGORIES.indexOf(b.m.category) || a.m.id.localeCompare(b.m.id));
    return scored.slice(0, 60).map((x) => x.m);
  }, [picker, models, q]);

  if (!picker) return null;
  const choose = (m: NodeModel) => {
    const id = m.category === "SubTree" ? `SubTree:${m.id}` : m.id;
    close();
    switch (picker.mode) {
      case "root":
        return void addNode(picker.treeId, nodeForPaletteId(id), null, "inside");
      case "child":
        return void addNode(picker.treeId, nodeForPaletteId(id), picker.uid!, "inside");
      case "after":
        return void addNode(picker.treeId, nodeForPaletteId(id), picker.uid!, "after");
      case "wrap":
        return wrapSelected(id);
      case "replace":
        return replaceSelected(id);
    }
  };

  return (
    <div className="picker" ref={ref} style={clampStyle(picker.x, picker.y, 320, 400)}>
      <div className="picker-title">{pickerTitle(picker)}</div>
      <input
        autoFocus
        placeholder="Type to search…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setIndex(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setIndex((i) => Math.min(i + 1, options.length - 1));
          else if (e.key === "ArrowUp") setIndex((i) => Math.max(i - 1, 0));
          else if (e.key === "Enter" && options[index]) choose(options[index]);
          else return;
          e.preventDefault();
        }}
      />
      <div className="picker-list">
        {options.map((m, i) => (
          <button
            key={`${m.category}:${m.id}`}
            className={`picker-item cat-${m.category.toLowerCase()} ${i === index ? "active" : ""}`}
            onMouseEnter={() => setIndex(i)}
            onClick={() => choose(m)}
          >
            <span className="palette-icon">{iconFor(m.id, m.category, m.metadata?.icon)}</span>
            <span className="picker-id">{m.id}</span>
            <span className="muted small-text">{m.category}</span>
          </button>
        ))}
        {options.length === 0 && <p className="muted pad">No matching node types.</p>}
      </div>
    </div>
  );
}

export function Dialogs() {
  const dialog = useStore((s) => s.dialog);
  if (!dialog) return null;
  const close = () => useStore.setState({ dialog: null });
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" onKeyDown={(e) => e.key === "Escape" && close()}>
        {dialog.kind === "browse" && <BrowseDialog mode={dialog.mode} close={close} />}
        {dialog.kind === "newTree" && <NewTreeDialog extractFrom={dialog.extractFrom} close={close} />}
        {dialog.kind === "moveTree" && <MoveTreeDialog treeId={dialog.treeId} close={close} />}
        {dialog.kind === "renameTree" && <RenameDialog treeId={dialog.treeId} close={close} />}
        {dialog.kind === "nodeType" && <NodeTypeDialog modelId={dialog.modelId} close={close} />}
        {dialog.kind === "licenses" && <LicensesDialog close={close} />}
      </div>
    </div>
  );
}

/** Arbor's licence, and those of the third-party programs this copy ships with. */
function LicensesDialog({ close }: { close: () => void }) {
  const [about, setAbout] = useState<AboutInfo | null>(null);
  const [libraries, setLibraries] = useState<LibraryLicense[] | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.about().then(setAbout, (e: Error) => setError(e.message));
    libraryLicenses().then(setLibraries, () => setLibraries(null));
  }, []);
  const git = about?.bundledGit;
  // Git ships with the desktop app; it goes in the list with the bundled libraries.
  const rows: (LibraryLicense & { git?: BundledGitInfo })[] = [...(libraries ?? [])];
  if (git) rows.push({ name: "git", version: git.version, license: "GPL-2.0-only", homepage: "https://git-scm.com", text: git.license, git });
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="licenses">
      <h3>Open-source licences</h3>
      <section>
        <h4>Arbor</h4>
        <p>
          Released under the{" "}
          <a href="https://github.com/coalman321/Arbor/blob/main/LICENSE" target="_blank" rel="noreferrer">
            MIT License
          </a>
          .
        </p>
      </section>
      <section>
        <h4>Included software</h4>
        {libraries === null && <p className="muted">The libraries are listed in built copies of Arbor; this one is running from source.</p>}
        {rows.length > 0 && (
          <>
            <p>Arbor includes this open-source software.</p>
            <ul className="license-list">
              {rows.map((l) => (
                <li key={`${l.name}@${l.version}`}>
                  <details>
                    <summary>
                      <span className="mono">{l.name}</span> <span className="muted">{l.version}</span>
                      <span className="license-id">{l.license}</span>
                    </summary>
                    {l.homepage && (
                      <a href={l.homepage} target="_blank" rel="noreferrer" className="small-text">
                        {l.homepage}
                      </a>
                    )}
                    {l.git && (
                      <p className="small-text">
                        The desktop app includes Git for computers that don't have it, to compare trees between revisions.{" "}
                        {l.git.inUse ? "This computer has no Git of its own, so Arbor is using it." : "Arbor is using this computer's own Git instead."}{" "}
                        Get its{" "}
                        <a href={l.git.source} target="_blank" rel="noreferrer">
                          source code
                        </a>{" "}
                        and{" "}
                        <a href={l.git.build} target="_blank" rel="noreferrer">
                          how this build was made
                        </a>
                        .
                      </p>
                    )}
                    {l.text && <pre className="license-text">{l.text}</pre>}
                  </details>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions">
        <button className="primary" onClick={close} autoFocus>
          Close
        </button>
      </div>
    </div>
  );
}

function NewTreeDialog({ extractFrom, close }: { extractFrom?: { treeId: string; uid: string }; close: () => void }) {
  const files = useStore((s) => s.files);
  const treesDir = useStore((s) => s.manifest?.trees ?? "trees");
  const [id, setId] = useState("");
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [existing, setExisting] = useState(Object.keys(files).filter((f) => !files[f].readOnlyReason)[0] ?? "");
  const [file, setFile] = useState("");
  const [error, setError] = useState<string | null>(null);
  const suggested = id ? fileNameFor(id) : `${treesDir}/new_tree.xml`;
  const submit = () => {
    const target = mode === "new" ? file || suggested : existing;
    const err = extractFrom ? extractToSubtree(extractFrom.treeId, extractFrom.uid, id, target) : createTree(id, target);
    if (err) setError(err);
    else close();
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <h3>{extractFrom ? "Extract to SubTree" : "New tree"}</h3>
      {extractFrom && (
        <p className="muted">
          The selected node and its children move to a new tree, replaced by a SubTree node. Blackboard keys they use become ports of the
          new tree, remapped to the same keys.
        </p>
      )}
      <label className="field">
        <span className="field-label">Tree ID</span>
        <input autoFocus value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. DockRobot" />
      </label>
      <div className="field">
        <span className="field-label">Save in</span>
        <label className="check">
          <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
          <span>A new file</span>
        </label>
        {mode === "new" && <input className="mono" value={file} placeholder={suggested} onChange={(e) => setFile(e.target.value)} />}
        <label className="check">
          <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} disabled={!Object.keys(files).length} />
          <span>An existing file</span>
        </label>
        {mode === "existing" && (
          <select value={existing} onChange={(e) => setExisting(e.target.value)}>
            {Object.keys(files)
              .filter((f) => !files[f].readOnlyReason)
              .sort()
              .map((f) => (
                <option key={f}>{f}</option>
              ))}
          </select>
        )}
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions">
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!id}>
          {extractFrom ? "Extract" : "Create"}
        </button>
      </div>
    </form>
  );
}

function MoveTreeDialog({ treeId, close }: { treeId: string; close: () => void }) {
  const files = useStore((s) => s.files);
  const current = useStore((s) => s.trees[treeId]?.file);
  const others = Object.values(files)
    .filter((f) => !f.deleted && !f.readOnlyReason && f.path !== current)
    .map((f) => f.path)
    .sort();
  const [mode, setMode] = useState<"existing" | "new">(others.length ? "existing" : "new");
  const [existing, setExisting] = useState(others[0] ?? "");
  const [file, setFile] = useState("");
  const [error, setError] = useState<string | null>(null);
  const suggested = fileNameFor(treeId);
  const leftAlone = current ? files[current]?.treeIds.length === 1 : false;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const dest = mode === "existing" ? existing : file || suggested;
        const err = moveTreeToFile(treeId, dest);
        if (err) setError(err);
        else close();
      }}
    >
      <h3>Move {treeId}</h3>
      <p className="muted">
        It's in <code>{current}</code>. Moving it changes which file it's saved in; SubTrees that use it keep working, since they refer to
        it by name.{leftAlone ? ` ${current} has no other trees, so it will be deleted when you save.` : ""}
      </p>
      <div className="field">
        <label className="check">
          <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} disabled={!others.length} />
          <span>Another file</span>
        </label>
        {mode === "existing" && (
          <select value={existing} onChange={(e) => setExisting(e.target.value)}>
            {others.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
        )}
        <label className="check">
          <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
          <span>A new file</span>
        </label>
        {mode === "new" && <input className="mono" autoFocus value={file} placeholder={suggested} onChange={(e) => setFile(e.target.value)} />}
      </div>
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions">
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Move
        </button>
      </div>
    </form>
  );
}

function RenameDialog({ treeId, close }: { treeId: string; close: () => void }) {
  const [id, setId] = useState(treeId);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const err = renameTree(treeId, id);
        if (err) setError(err);
        else close();
      }}
    >
      <h3>Rename {treeId}</h3>
      <p className="muted">Every SubTree that references it is updated too.</p>
      <label className="field">
        <span className="field-label">New ID</span>
        <input autoFocus value={id} onChange={(e) => setId(e.target.value)} />
      </label>
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions">
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="primary">
          Rename
        </button>
      </div>
    </form>
  );
}

function NodeTypeDialog({ modelId, close }: { modelId?: string; close: () => void }) {
  const specModels = useStore((s) => s.specModels);
  const specEnums = useStore((s) => s.specEnums);
  const specFile = useStore((s) => s.manifest?.nodes ?? "nodes.xml");
  const models = useModels();
  const original = modelId ? specModels.find((m) => m.id === modelId) : undefined;
  const [id, setId] = useState(original?.id ?? "");
  const [category, setCategory] = useState<NodeCategory>(original?.category ?? "Action");
  const [description, setDescription] = useState(original?.description ?? "");
  const [icon, setIcon] = useState(original?.metadata?.icon ?? "");
  const [ports, setPorts] = useState<PortModel[]>(original?.ports ?? []);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id)) return setError("ID must be a C++-style identifier");
    if (id !== modelId && models.has(id)) return setError(`"${id}" already exists`);
    const names = ports.map((p) => p.name);
    if (names.some((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) return setError("Port names must be identifiers");
    if (new Set(names).size !== names.length) return setError("Port names must be unique");
    const glyph = icon.trim();
    // The icon is kept with any other <MetaFields> the spec already has for this type.
    const meta = { ...original?.metadata };
    delete meta.icon;
    const metadata = glyph ? { ...meta, icon: glyph } : meta;
    const model: NodeModel = { id, category, ports, source: "spec", ...(description ? { description } : {}), ...(Object.keys(metadata).length ? { metadata } : {}) };
    if (await saveSpecModel(model, modelId)) close();
  };
  const setPort = (i: number, patch: Partial<PortModel>) => setPorts(ports.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="node-type-form"
    >
      <h3>{original ? `Edit ${original.id}` : "New node type"}</h3>
      <p className="muted">
        Saved to <code>{specFile}</code>. If that file is generated from robot code, make the same change in C++ or it will be overwritten.
      </p>
      <div className="row">
        <label className="field grow">
          <span className="field-label">ID</span>
          <input autoFocus value={id} onChange={(e) => setId(e.target.value)} placeholder="e.g. MoveArm" />
        </label>
        <label className="field">
          <span className="field-label">Category</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as NodeCategory)}>
            {NODE_CATEGORIES.filter((c) => c !== "SubTree").map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <label className="field grow">
          <span className="field-label">Description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
        <div className="field">
          <span className="field-label">Icon</span>
          <IconPicker value={icon} fallback={iconFor(id, category)} onChange={setIcon} />
        </div>
      </div>
      <h4 className="section-title">Ports</h4>
      <table className="ports-table">
        <thead>
          <tr>
            <th>Dir</th>
            <th>Name</th>
            <th>Type</th>
            <th>Default</th>
            <th>Description</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {ports.map((p, i) => (
            <tr key={i}>
              <td>
                <select value={p.direction} onChange={(e) => setPort(i, { direction: e.target.value as PortDirection })}>
                  <option value="input">in</option>
                  <option value="output">out</option>
                  <option value="inout">in/out</option>
                </select>
              </td>
              <td>
                <input className="mono" value={p.name} onChange={(e) => setPort(i, { name: e.target.value })} />
              </td>
              <td>
                <input
                  className="mono"
                  list="spec-enum-types"
                  value={p.type ?? ""}
                  placeholder="std::string"
                  onChange={(e) => setPort(i, { type: e.target.value || undefined })}
                />
              </td>
              <td>
                <input
                  className="mono"
                  list={`spec-enum-values-${i}`}
                  value={p.default ?? ""}
                  onChange={(e) => setPort(i, { default: e.target.value === "" ? undefined : e.target.value })}
                />
                <datalist id={`spec-enum-values-${i}`}>
                  {specEnums
                    .find((e) => e.type === p.type)
                    ?.values.map((v) => <option key={v.name} value={v.name} />)}
                </datalist>
              </td>
              <td>
                <input value={p.description ?? ""} onChange={(e) => setPort(i, { description: e.target.value || undefined })} />
              </td>
              <td>
                <button type="button" className="icon-button" onClick={() => setPorts(ports.filter((_, j) => j !== i))}>
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <datalist id="spec-enum-types">
        {specEnums.map((e) => (
          <option key={e.type} value={e.type} />
        ))}
      </datalist>
      <button type="button" onClick={() => setPorts([...ports, { name: `port${ports.length + 1}`, direction: "input", type: "std::string" }])}>
        + Add port
      </button>
      {error && <p className="error-text">{error}</p>}
      <div className="modal-actions">
        {original && (
          <button
            type="button"
            className="danger"
            onClick={async () => {
              if (confirm(`Remove ${original.id} from ${specFile}?`) && (await saveSpecModel(null, original.id))) close();
            }}
          >
            Delete
          </button>
        )}
        <div className="spacer" />
        <button type="button" onClick={close}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={!id}>
          Save to {specFile}
        </button>
      </div>
    </form>
  );
}

const PICKER_WIDTH = 290;
const PICKER_HEIGHT = 340;

/** A button showing the chosen icon that opens a grid of icons to choose from. */
function IconPicker({ value, fallback, onChange }: { value: string; fallback: string; onChange: (icon: string) => void }) {
  // Where the grid goes, fixed to the window so the dialog's scrolling doesn't clip it; null when closed.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const open = pos !== null;
  const ref = useRef<HTMLDivElement>(null);
  const toggle = (button: HTMLElement) => {
    if (open) return setPos(null);
    const r = button.getBoundingClientRect();
    const below = r.bottom + 4 + PICKER_HEIGHT <= window.innerHeight;
    setPos({ top: below ? r.bottom + 4 : Math.max(8, r.top - 4 - PICKER_HEIGHT), left: Math.max(8, r.right - PICKER_WIDTH) });
  };
  useDismiss(ref, () => setPos(null), open);
  const choose = (icon: string) => {
    onChange(icon);
    setPos(null);
  };
  return (
    <div
      className="icon-picker"
      ref={ref}
      onKeyDown={(e) => {
        // Escape closes just the grid, not the dialog around it.
        if (open && e.key === "Escape") {
          e.stopPropagation();
          setPos(null);
        }
      }}
    >
      <button
        type="button"
        className={`icon-picker-button ${value ? "" : "muted"}`}
        onClick={(e) => toggle(e.currentTarget)}
        title={value ? "Change the icon" : "Using the category's icon; click to choose one"}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        {value || fallback}
      </button>
      {open && (
        <div className="popover icon-picker-popover" style={{ ...pos, width: PICKER_WIDTH, maxHeight: PICKER_HEIGHT }} role="dialog" aria-label="Choose an icon">
          <button type="button" className={`icon-picker-default ${value ? "" : "selected"}`} onClick={() => choose("")}>
            <span className="muted">{fallback}</span> Category default
          </button>
          {ICON_CHOICES.map(({ group, icons }) => (
            <div key={group}>
              <div className="icon-picker-group">{group}</div>
              <div className="icon-picker-grid">
                {icons.map(([icon, name]) => (
                  <button
                    type="button"
                    key={icon}
                    className={`icon-picker-choice ${icon === value ? "selected" : ""}`}
                    onClick={() => choose(icon)}
                    title={name}
                    aria-label={name}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function ConflictBanner() {
  const conflicts = useStore((s) => s.conflicts);
  if (!conflicts.length) return null;
  return (
    <div className="banner">
      {conflicts.map((p) => (
        <div key={p} className="row">
          <span>
            <strong>{p}</strong> changed on disk while you have unsaved edits.
          </span>
          <div className="spacer" />
          <button onClick={() => void resolveConflict(p, "reload")}>Reload from disk</button>
          <button onClick={() => void resolveConflict(p, "keep")}>Keep mine</button>
        </div>
      ))}
    </div>
  );
}

export function Toast() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  return (
    <div className={`toast ${toast.kind}`} role="status">
      {toast.text}
    </div>
  );
}
