import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NODE_CATEGORIES, type NodeModel } from "../../shared/model.ts";
import { addNode, nodeForPaletteId, selectedNode, canHaveMoreChildren } from "../actions.ts";
import {
  deleteTree,
  localStorageGet,
  localStorageSet,
  moveTreeToFile,
  openTree,
  setMainTree,
  toast,
  treesUsing,
  useModels,
  useStore,
} from "../store.ts";
import { PALETTE_MIME } from "./Canvas.tsx";
import { iconFor } from "./icons.ts";

/** Drag data for a tree being dragged onto another file in the list (to move it there). */
const TREE_MIME = "application/x-bt-tree";
const SPLIT_KEY = "bt-editor.treesPanelHeight";

export function Sidebar() {
  const ref = useRef<HTMLElement>(null);
  const [height, setHeight] = useState<number | null>(() => {
    const v = Number(localStorageGet(SPLIT_KEY));
    return v > 0 ? v : null;
  });
  // Dragging the handle between the two lists resizes the Trees list; the Nodes list takes the rest.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const aside = ref.current!;
    const top = aside.getBoundingClientRect().top;
    const max = aside.clientHeight - 140;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setHeight(Math.round(Math.max(70, Math.min(max, ev.clientY - top))));
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      setHeight((h) => {
        if (h) localStorageSet(SPLIT_KEY, String(h));
        return h;
      });
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };
  return (
    <aside className="sidebar" ref={ref}>
      <ProjectTrees height={height} />
      <div
        className="split-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the trees and nodes lists"
        title="Drag to resize · double-click to reset"
        onPointerDown={startResize}
        onDoubleClick={() => {
          setHeight(null);
          localStorageSet(SPLIT_KEY, "");
        }}
      />
      <Palette />
    </aside>
  );
}

interface TreeMenu {
  id: string;
  file: string;
  x: number;
  y: number;
}

/** The ⋯ menu of a tree, drawn over everything (not inside the scrolling list). */
function TreeMenuPopup({ menu, close }: { menu: TreeMenu; close: () => void }) {
  const trees = useStore((s) => s.trees);
  const files = useStore((s) => s.files);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && close();
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("mousedown", down);
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [close]);
  const { id } = menu;
  const f = files[menu.file];
  const run = (fn: () => void) => () => {
    close();
    fn();
  };
  // Keep it on screen.
  const style = { left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 170) };
  return createPortal(
    <div className="menu tree-menu" ref={ref} style={style} role="menu">
      <button onClick={run(() => openTree(id))}>Open</button>
      <button onClick={run(() => useStore.setState({ dialog: { kind: "renameTree", treeId: id } }))}>Rename…</button>
      <button onClick={run(() => useStore.setState({ dialog: { kind: "moveTree", treeId: id } }))}>Move to file…</button>
      <button onClick={run(() => setMainTree(id, f?.mainTree !== id))}>{f?.mainTree === id ? "Unset main tree" : "Set as main tree of file"}</button>
      <hr />
      <button
        className="danger"
        onClick={run(() => {
          const users = treesUsing(trees, id);
          const warn = users.length ? `\n\nIt is used as a SubTree by: ${users.map((u) => u.id).join(", ")}` : "";
          if (confirm(`Delete tree "${id}"?${warn}`)) deleteTree(id);
        })}
      >
        Delete tree
      </button>
    </div>,
    document.body,
  );
}

function ProjectTrees({ height }: { height: number | null }) {
  const files = useStore((s) => s.files);
  const active = useStore((s) => s.active);
  const trees = useStore((s) => s.trees);
  const [menu, setMenu] = useState<TreeMenu | null>(null);
  const [dropFile, setDropFile] = useState<string | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const sorted = Object.values(files)
    .filter((f) => !f.deleted)
    .sort((a, b) => a.path.localeCompare(b.path));

  const dropProps = (path: string, readOnly: boolean) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(TREE_MIME) || readOnly) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (dropFile !== path) setDropFile(path);
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropFile(null);
    },
    onDrop: (e: React.DragEvent) => {
      const id = e.dataTransfer.getData(TREE_MIME);
      setDropFile(null);
      if (!id) return;
      e.preventDefault();
      const err = moveTreeToFile(id, path);
      if (err) toast(err, "error");
      else if (useStore.getState().trees[id]?.file === path) toast(`Moved ${id} to ${path} (unsaved)`);
    },
  });

  return (
    <section className="panel trees-panel" style={height ? { height, maxHeight: "none" } : undefined}>
      <header className="panel-header">
        <span>Trees</span>
        <div className="row">
          <button
            className="small"
            onClick={() => useStore.setState({ dialog: { kind: "browse", mode: "importTree" } })}
            title="Copy an existing tree file (.xml) into this project"
          >
            Add file…
          </button>
          <button className="small" onClick={() => useStore.setState({ dialog: { kind: "newTree" } })} title="Create a new tree">
            + New tree
          </button>
        </div>
      </header>
      <div className="panel-body">
        {sorted.map((f) => (
          <div key={f.path} className={`file-group ${dropFile === f.path ? "drop-target" : ""}`} {...dropProps(f.path, !!f.readOnlyReason)}>
            <div className="file-name" title={f.readOnlyReason ?? `${f.path}\nDrop a tree here to move it into this file`}>
              {f.path.replace(/^[^/]+\//, "")}
              {f.dirty && <span className="dirty-dot" title="Unsaved changes" />}
              {f.readOnlyReason && <span className="badge badge-error">read-only</span>}
            </div>
            {f.treeIds.map((id) => (
              <div
                key={id}
                className={`tree-item ${active === id ? "active" : ""}`}
                onClick={() => openTree(id)}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(PALETTE_MIME, `SubTree:${id}`);
                  e.dataTransfer.setData(TREE_MIME, id);
                  e.dataTransfer.effectAllowed = "copyMove";
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ id, file: f.path, x: e.clientX, y: e.clientY });
                }}
                title="Click to open · drag onto a node to use as a SubTree · drag onto another file to move it there"
              >
                <span className="tree-icon">▣</span>
                <span className="tree-label">{id}</span>
                {f.mainTree === id && (
                  <span className="main-badge" title="main_tree_to_execute">
                    main
                  </span>
                )}
                {!trees[id]?.root && <span className="muted small-text">empty</span>}
                <button
                  className={`icon-button ${menu?.id === id ? "open" : ""}`}
                  title="Tree actions"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (menu?.id === id) return setMenu(null);
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ id, file: f.path, x: r.left, y: r.bottom + 2 });
                  }}
                >
                  ⋯
                </button>
              </div>
            ))}
          </div>
        ))}
        {sorted.length === 0 && <p className="muted pad">No tree files yet.</p>}
      </div>
      {menu && <TreeMenuPopup menu={menu} close={closeMenu} />}
    </section>
  );
}

function Palette() {
  const models = useModels();
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const all = [...models.values()];
    const match = (m: NodeModel) =>
      !f || m.id.toLowerCase().includes(f) || (m.description ?? "").toLowerCase().includes(f) || m.ports.some((p) => p.name.includes(f));
    const out = new Map<string, NodeModel[]>();
    for (const cat of NODE_CATEGORIES) out.set(cat, []);
    for (const m of all) {
      if (m.id === "SubTree" && m.source === "builtin") continue;
      if (match(m)) out.get(m.category)?.push(m);
    }
    for (const list of out.values()) list.sort((a, b) => Number(a.source === "builtin") - Number(b.source === "builtin") || a.id.localeCompare(b.id));
    return out;
  }, [models, filter]);

  const quickAdd = (paletteId: string) => {
    const s = useStore.getState();
    if (!s.active) return toast("Open a tree first", "error");
    const tree = s.trees[s.active];
    const node = nodeForPaletteId(paletteId);
    if (!tree.root) return void addNode(tree.id, node, null, "inside");
    const sel = selectedNode();
    if (!sel) return toast("Select a node to add to, or drag onto the canvas", "error");
    addNode(sel.treeId, node, sel.node.uid, canHaveMoreChildren(sel.node) ? "inside" : "after");
  };

  return (
    <section className="panel palette-panel">
      <header className="panel-header">
        <span>Nodes</span>
        <button className="small" onClick={() => useStore.setState({ dialog: { kind: "nodeType" } })} title="Declare a new node type in the spec file">
          + Node type
        </button>
      </header>
      <div className="palette-search">
        <input placeholder="Search nodes…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="panel-body">
        {[...groups].map(([cat, list]) =>
          list.length === 0 ? null : (
            <div key={cat} className="palette-group">
              <button className="palette-group-header" onClick={() => setCollapsed({ ...collapsed, [cat]: !collapsed[cat] })}>
                <span className={`cat-dot cat-${cat.toLowerCase()}`} />
                {cat === "SubTree" ? "SubTrees" : `${cat}s`}
                <span className="muted">{list.length}</span>
                <span className="chevron">{collapsed[cat] && !filter ? "▸" : "▾"}</span>
              </button>
              {(!collapsed[cat] || filter) &&
                list.map((m) => {
                  const paletteId = m.category === "SubTree" ? `SubTree:${m.id}` : m.id;
                  return (
                    <div
                      key={paletteId}
                      className={`palette-item cat-${m.category.toLowerCase()}`}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData(PALETTE_MIME, paletteId);
                        e.dataTransfer.effectAllowed = "copy";
                      }}
                      onDoubleClick={() => quickAdd(paletteId)}
                      title={`${m.description ?? m.id}${m.ports.length ? "\n\nPorts: " + m.ports.map((p) => `${p.name} (${p.direction})`).join(", ") : ""}\n\nDrag onto the canvas, or double-click to add to the selected node.`}
                    >
                      <span className="palette-icon">{iconFor(m.id, m.category)}</span>
                      <span className="palette-label">{m.id}</span>
                      {m.source === "spec" && (
                        <button
                          className="icon-button"
                          title="Edit node type"
                          onClick={(e) => {
                            e.stopPropagation();
                            useStore.setState({ dialog: { kind: "nodeType", modelId: m.id } });
                          }}
                        >
                          ✎
                        </button>
                      )}
                    </div>
                  );
                })}
            </div>
          ),
        )}
      </div>
    </section>
  );
}
