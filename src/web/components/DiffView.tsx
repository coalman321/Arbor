// Compare mode's screen: revision pickers and the changed trees on the left, the merged tree in the
// middle, and what changed about the selected node on the right. Nothing here can be edited.

import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getSmoothStepPath,
  ReactFlow,
  useReactFlow,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { findParent, nodeLabel, WORKTREE, type BTNode, type NodeModel } from "../../shared/model.ts";
import type { TreeDefDiff, TreeDefStatus } from "../../shared/tree_diff.ts";
import { modelFor } from "../../shared/validate.ts";
import {
  closeCompare,
  compare,
  mergedModels,
  reloadGitInfo,
  resolveDiffPath,
  showDiffTree,
  sortTreeDiffs,
  stepChange,
  useStops,
  type DiffState,
  type GitRevs,
} from "../diff.ts";
import { diffLines, treeKey, type Mark, type MarkKind, type MergedTree } from "../diff_view.ts";
import { categoryOf, layoutTree } from "../layout.ts";
import { select, useStore } from "../store.ts";
import { BTNodeView, FrameView, WindowView, type BTFlowNode } from "./BTNodeView.tsx";
import { iconFor } from "./icons.ts";
import { PanelResizer, type PanelSizes } from "./PanelResizer.tsx";

export function DiffView({ sizes, setSize }: { sizes: PanelSizes; setSize: (edge: keyof PanelSizes, size: number | null) => void }) {
  return (
    <>
      <CompareSidebar />
      <PanelResizer edge="left" size={sizes.left} onResize={(v) => setSize("left", v)} />
      <div className="center">
        <CompareBar />
        <DiffCanvas />
      </div>
      <PanelResizer edge="right" size={sizes.right} onResize={(v) => setSize("right", v)} />
      <DiffInspector />
    </>
  );
}

/** Keys in compare mode: N / Shift+N step through changes, F fits, Escape clears the selection. */
export function onCompareKey(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === "n") stepChange(e.shiftKey ? -1 : 1);
  else if (key === "f") useStore.setState({ fitRequest: useStore.getState().fitRequest + 1 });
  else if (e.key === "Escape") select(null);
  else return;
  e.preventDefault();
}

const STATUS_ICON: Record<TreeDefStatus, string> = { changed: "~", renamed: "→", added: "+", removed: "−", unchanged: "·" };

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  const units: [number, string][] = [
    [60, "minute"],
    [3600, "hour"],
    [86400, "day"],
    [604800, "week"],
    [2629800, "month"],
    [31557600, "year"],
  ];
  let [size, name] = units[0];
  for (const u of units) if (s >= u[0]) [size, name] = u;
  const n = Math.floor(s / size);
  return `${n} ${name}${n === 1 ? "" : "s"} ago`;
}

/** How a revision is shown: a title, and a muted detail line. */
function describeRev(rev: string, git: GitRevs): { title: string; detail: string } {
  if (rev === WORKTREE) return { title: "Working tree", detail: "files on disk" };
  const c = git.commits.find((c) => c.sha === rev || c.short === rev);
  if (c) return { title: c.subject, detail: `${c.short} · ${c.author} · ${ago(c.date)}` };
  if (rev === git.branch) return { title: rev, detail: "current branch" };
  if (git.branches.includes(rev)) return { title: rev, detail: "branch" };
  if (git.tags.includes(rev)) return { title: rev, detail: "tag" };
  return { title: rev, detail: "revision" };
}

interface RevOption {
  rev: string;
  title: string;
  detail: string;
}

/** A searchable list of the working tree, branches, tags, and recent commits; or any typed revision. */
function RevPicker({ label, value, onChange }: { label: string; value: string; onChange: (rev: string) => void }) {
  const git = useStore((s) => s.diff!.git);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", down);
    return () => window.removeEventListener("mousedown", down);
  }, [open]);

  const options = useMemo(() => {
    const all: RevOption[] = [
      { rev: WORKTREE, title: "Working tree", detail: "files on disk" },
      ...git.branches.map((b) => ({ rev: b, title: b, detail: b === git.branch ? "current branch" : "branch" })),
      ...git.tags.map((t) => ({ rev: t, title: t, detail: "tag" })),
      ...git.commits.map((c) => ({ rev: c.sha, title: c.subject, detail: `${c.short} · ${c.author} · ${ago(c.date)}` })),
    ];
    const q = query.trim().toLowerCase();
    const hits = q ? all.filter((o) => `${o.title} ${o.detail} ${o.rev}`.toLowerCase().includes(q)) : all;
    // A typed name or commit id that's already in the list doesn't need a "Use" entry of its own.
    const exact = all.some((o) => o.rev === query.trim() || (/^[0-9a-f]{4,}$/i.test(query.trim()) && o.rev.startsWith(query.trim())));
    return q && !exact ? [{ rev: query.trim(), title: `Use “${query.trim()}”`, detail: "any branch, tag, or commit" }, ...hits] : hits;
  }, [git, query]);

  const pick = (rev: string) => {
    setOpen(false);
    setQuery("");
    if (rev !== value) onChange(rev);
  };
  const current = describeRev(value, git);
  return (
    <div className="rev-picker" ref={ref}>
      <span className="rev-picker-label">{label}</span>
      <button
        className={`rev-picker-button ${open ? "on" : ""}`}
        onClick={() => {
          if (!open) void reloadGitInfo();
          setOpen(!open);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value === WORKTREE ? "The tree files as saved on disk" : value}
      >
        <span className="rev-title">{current.title}</span>
        <span className="rev-detail muted small-text">{current.detail}</span>
      </button>
      {open && (
        <div className="popover rev-popover">
          <input
            autoFocus
            placeholder="Search, or type a branch, tag, or commit…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && options[0]) pick(options[0].rev);
              if (e.key === "Escape") setOpen(false);
            }}
          />
          <div className="rev-options" role="listbox">
            {options.map((o) => (
              <button key={`${o.detail}:${o.rev}`} role="option" aria-selected={o.rev === value} className={`rev-option ${o.rev === value ? "on" : ""}`} onClick={() => pick(o.rev)}>
                <span className="rev-title">{o.title}</span>
                <span className="rev-detail muted small-text">{o.detail}</span>
              </button>
            ))}
            {options.length === 0 && <p className="muted pad">Nothing matches.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function CompareSidebar() {
  const d = useStore((s) => s.diff!);
  const dirty = useStore((s) => Object.values(s.files).filter((f) => f.dirty).length);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const sorted = useMemo(() => sortTreeDiffs(d.trees), [d.trees]);
  const changed = sorted.filter((t) => t.status !== "unchanged");
  const unchanged = sorted.filter((t) => t.status === "unchanged");
  const usesWorktree = d.base === WORKTREE || d.target === WORKTREE;

  return (
    <aside className="sidebar compare-sidebar">
      <section className="panel compare-revs">
        <header className="panel-header">
          <span>Compare</span>
          <button className="small" onClick={closeCompare} title="Back to editing">
            Done
          </button>
        </header>
        <div className="compare-revs-body">
          <RevPicker label="From" value={d.base} onChange={(r) => void compare(r, d.target)} />
          <button className="icon-button compare-swap" onClick={() => void compare(d.target, d.base)} title="Swap the two revisions">
            ⇅
          </button>
          <RevPicker label="To" value={d.target} onChange={(r) => void compare(d.base, r)} />
          {usesWorktree && dirty > 0 && (
            <p className="compare-note small-text">
              The working tree is what's saved on disk: unsaved edits in {dirty} file{dirty === 1 ? "" : "s"} aren't included.
            </p>
          )}
        </div>
      </section>
      <section className="panel compare-trees">
        <header className="panel-header">
          <span>{d.status === "ready" ? `${changed.length} tree${changed.length === 1 ? "" : "s"} changed` : "Trees"}</span>
        </header>
        <div className="panel-body">
          {d.status === "loading" && <p className="muted pad">Reading both versions…</p>}
          {d.status === "error" && <p className="pad compare-error">{d.error}</p>}
          {d.status === "ready" && changed.length === 0 && <p className="muted pad">The trees are the same in both versions.</p>}
          {changed.map((t) => (
            <TreeRow key={treeKey(t)} t={t} active={d.active === treeKey(t)} />
          ))}
          {unchanged.length > 0 && (
            <button className="link compare-unchanged-toggle" onClick={() => setShowUnchanged(!showUnchanged)}>
              {showUnchanged ? "Hide" : "Show"} {unchanged.length} unchanged
            </button>
          )}
          {showUnchanged && unchanged.map((t) => <TreeRow key={treeKey(t)} t={t} active={d.active === treeKey(t)} />)}
        </div>
      </section>
    </aside>
  );
}

function TreeRow({ t, active }: { t: TreeDefDiff; active: boolean }) {
  const key = treeKey(t);
  const file = t.meta.file ? `${t.meta.file.old} → ${t.meta.file.new}` : (t.new ?? t.old)!.file;
  return (
    <div className={`tree-item compare-tree ${active ? "active" : ""}`} onClick={() => showDiffTree(key)} title={`${t.status} · ${file}`}>
      <span className={`diff-status st-${t.status}`} aria-label={t.status}>
        {STATUS_ICON[t.status]}
      </span>
      <span className="tree-label">
        {key}
        {t.status === "renamed" && <span className="muted"> (was {t.old!.id})</span>}
      </span>
      {t.nodes.changes > 0 && <span className="diff-count">{t.nodes.changes}</span>}
    </div>
  );
}

/** Counts of what happened to a tree's nodes, for the legend. */
function countMarks(tree: MergedTree): Record<"added" | "removed" | "edited" | "moved", number> {
  const c = { added: 0, removed: 0, edited: 0, moved: 0 };
  for (const m of tree.marks.values()) {
    if (m.kind === "added") c.added++;
    else if (m.kind === "removed") c.removed++;
    if (m.kind === "moved") c.moved++;
    if (m.edited) c.edited++;
  }
  return c;
}

function CompareBar() {
  const d = useStore((s) => s.diff!);
  const { stops, index } = useStops();
  const tree = d.active ? d.merged[d.active] : undefined;
  const counts = tree ? countMarks(tree) : null;
  return (
    <div className="compare-bar">
      {tree && (
        <>
          <span className="compare-bar-title">{tree.key}</span>
          <span className={`diff-chip st-${tree.diff.status}`}>{tree.diff.status}</span>
        </>
      )}
      <span className="spacer" />
      {counts && (
        <span className="compare-legend">
          {counts.added > 0 && <span className="legend-item k-added">+{counts.added} added</span>}
          {counts.removed > 0 && <span className="legend-item k-removed">−{counts.removed} removed</span>}
          {counts.edited > 0 && <span className="legend-item k-changed">~{counts.edited} edited</span>}
          {counts.moved > 0 && <span className="legend-item k-moved">↔{counts.moved} moved</span>}
        </span>
      )}
      <div className="toolbar-group compare-nav">
        <button className="small" disabled={!stops.length} onClick={() => stepChange(-1)} title="Previous change (Shift+N)">
          ‹ Prev
        </button>
        <span className="muted small-text compare-pos">{index >= 0 ? `${index + 1} of ${stops.length}` : `${stops.length} change${stops.length === 1 ? "" : "s"}`}</span>
        <button className="small" disabled={!stops.length} onClick={() => stepChange(1)} title="Next change (N)">
          Next ›
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Canvas

const nodeTypes = { bt: BTNodeView, frame: FrameView, window: WindowView };

type DiffEdgeData = { label?: string; dir: "TB" | "LR"; bus?: number; kind?: MarkKind };

function DiffEdgeImpl(props: EdgeProps<Edge<DiffEdgeData>>) {
  const { data } = props;
  const bus = data?.bus;
  const [path] = getSmoothStepPath({
    ...props,
    borderRadius: 10,
    ...(bus === undefined ? {} : data?.dir === "LR" ? { centerX: bus } : { centerY: bus }),
  });
  const lr = data?.dir === "LR";
  return (
    <>
      <BaseEdge path={path} className={`bt-edge ${data?.kind && data.kind !== "same" ? `diff-${data.kind}` : ""}`} />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            className="bt-edge-label nodrag nopan"
            style={{
              transform: lr
                ? `translate(-100%, -100%) translate(${props.targetX - 8}px, ${props.targetY - 3}px)`
                : `translate(-50%, -100%) translate(${props.targetX}px, ${props.targetY - 5}px)`,
            }}
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
const edgeTypes = { diff: memo(DiffEdgeImpl) };

function DiffCanvas() {
  const d = useStore((s) => s.diff!);
  const expanded = useStore((s) => s.expanded);
  const dir = useStore((s) => s.layoutDir);
  const decoratorFrames = useStore((s) => s.decoratorFrames);
  const fitRequest = useStore((s) => s.fitRequest);
  const flow = useReactFlow();
  const { merged, selection, old: oldRev, new: newRev } = d;
  const tree = d.active ? merged[d.active] : undefined;
  const models = useMemo(() => mergedModels(oldRev, newRev), [oldRev, newRev]);
  const defs = useMemo(() => Object.fromEntries(Object.entries(merged).map(([k, m]) => [k, m.def])), [merged]);

  const items = useMemo(
    () =>
      tree
        ? layoutTree(tree.def, defs, {
            isExpanded: (p) => !!expanded[`diff:${tree.key}|${p}`],
            dir,
            frameDecorator: decoratorFrames ? (n) => modelFor(n, models)?.category === "Decorator" : undefined,
            linesFor: (n, treeId) => diffLines(n, merged[treeId]?.marks.get(n.uid)),
          })
        : [],
    [tree, defs, expanded, dir, decoratorFrames, models, merged],
  );
  const byPath = useMemo(() => new Map(items.map((i) => [i.path, i])), [items]);
  // Nodes drawn inside another (folded conditions) are revealed by the box that shows them.
  const boxFor = useMemo(() => {
    const m = new Map(byPath);
    for (const i of items) for (const p of i.foldedPaths) m.set(p, i);
    return m;
  }, [items, byPath]);

  const nodes = useMemo<BTFlowNode[]>(
    () =>
      items.map((item) => ({
        id: item.path,
        type: item.window ? "window" : item.frame ? "frame" : "bt",
        position: { x: item.x, y: item.y },
        zIndex: item.frame ? item.frame.level : 1000,
        // Only a frame's header takes the pointer (see the editor's Canvas).
        ...(item.frame ? { style: { pointerEvents: "none" as const } } : {}),
        data: {
          item,
          category: categoryOf(item.node, models),
          icon: modelFor(item.node, models)?.metadata?.icon,
          problems: [],
          foldedProblems: {},
          dir,
          liveMain: false,
        },
        draggable: false,
        selected: item.path === selection,
      })),
    [items, models, dir, selection],
  );
  const edges = useMemo<Edge<DiffEdgeData>[]>(
    () =>
      items
        .filter((i) => i.parentPath && !byPath.get(i.parentPath)?.frame)
        .map((i) => ({
          id: `${i.parentPath}->${i.path}`,
          source: i.parentPath!,
          target: i.path,
          type: "diff",
          data: { label: i.edgeLabel, dir, bus: i.edgeBus, kind: i.window ? undefined : merged[i.treeId]?.marks.get(i.node.uid)?.kind },
          selectable: false,
        })),
    [items, byPath, dir, merged],
  );

  const center = (path: string) => {
    const it = boxFor.get(path);
    if (!it) return false;
    const r = it.frame ? (dir === "TB" ? { ...it, h: it.frame.headerH } : { ...it, w: it.frame.headerW }) : it;
    flow.setCenter(r.x + r.w / 2, r.y + r.h / 2, { zoom: Math.max(flow.getZoom(), 0.9), duration: 250 });
    return true;
  };

  // Fit when the tree or the comparison changes; if a change was just stepped to, center on it.
  const lastFit = useRef("");
  useEffect(() => {
    const key = `${d.active}|${fitRequest}|${dir}|${oldRev?.sha}|${newRev?.sha}`;
    if (key === lastFit.current || !items.length) return;
    lastFit.current = key;
    requestAnimationFrame(() => {
      if (!selection || !center(selection)) flow.fitView({ padding: 0.15, maxZoom: 1.1, duration: 200 });
    });
  });

  useEffect(() => {
    const onReveal = (e: Event) => center((e as CustomEvent<string>).detail);
    window.addEventListener("bt-reveal", onReveal);
    return () => window.removeEventListener("bt-reveal", onReveal);
  });

  let empty: ReactNode = null;
  if (d.status === "loading" && !tree) empty = <p className="muted">Reading both versions…</p>;
  else if (d.status === "error")
    empty = (
      <>
        <p>Couldn't compare these revisions.</p>
        <p className="muted">{d.error}</p>
      </>
    );
  else if (!tree) empty = <p className="muted">There are no trees in either version.</p>;
  else if (!tree.def.root) empty = <p className="muted">{tree.key} is empty in both versions.</p>;
  if (empty) return <div className="canvas-empty">{empty}</div>;

  return (
    <div className={`canvas compare-canvas ${d.status === "loading" ? "is-loading" : ""}`}>
      <ReactFlow<BTFlowNode, Edge<DiffEdgeData>>
        className={dir === "LR" ? "lr" : ""}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        minZoom={0.1}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        onNodeClick={(_, n) => select(byPath.get(n.id)?.window ? byPath.get(n.id)!.parentPath : n.id)}
        onNodeDoubleClick={(_, n) => {
          const it = byPath.get(n.id);
          if (it?.node.type === "SubTree" && it.node.attrs.ID && merged[it.node.attrs.ID]) showDiffTree(it.node.attrs.ID);
        }}
        onPaneClick={() => select(null)}
      >
        <Background gap={24} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Details panel

function DiffInspector() {
  const d = useStore((s) => s.diff!);
  const models = useMemo(() => mergedModels(d.old, d.new), [d.old, d.new]);
  const tree = d.active ? d.merged[d.active] : undefined;
  const hit = d.selection ? resolveDiffPath(d, d.selection) : null;
  return (
    <aside className="inspector compare-inspector">
      <div className="inspector-body">
        {hit ? <NodeChanges d={d} hit={hit} models={models} /> : tree ? <TreeChanges tree={tree} /> : <p className="muted">Pick a tree on the left.</p>}
      </div>
    </aside>
  );
}

const KIND_TEXT: Record<MarkKind, string> = {
  added: "Added",
  removed: "Removed",
  moved: "Moved",
  "moved-away": "Moved away",
  changed: "Edited",
  same: "Unchanged",
};

function NodeChanges({ d, hit, models }: { d: DiffState; hit: NonNullable<ReturnType<typeof resolveDiffPath>>; models: Map<string, NodeModel> }) {
  const { tree, node, mark, prefix } = hit;
  const oldRoot = tree.diff.old?.root ?? null;
  const newRoot = tree.diff.new?.root ?? null;
  const oldParent = mark.oldNode && findParent(oldRoot, mark.oldNode.uid);
  const newParent = mark.newNode && findParent(newRoot, mark.newNode.uid);
  const category = categoryOf(node, models);
  const name = (n: BTNode | null | undefined) => <strong>{n ? nodeLabel(n) : "the top"}</strong>;
  const goTo = (uid: string) => {
    const path = prefix ? `${prefix}/${uid}` : uid;
    select(path);
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent("bt-reveal", { detail: path })));
  };

  let story: ReactNode = null;
  switch (mark.kind) {
    case "added":
      story = <>Only in the new version.</>;
      break;
    case "removed":
      story = <>Only in the old version: it was removed.</>;
      break;
    case "moved":
      story = mark.reordered ? (
        <>Its position among the children of {name(newParent)} changed. Child order is execution order.</>
      ) : (
        <>
          Moved from under {name(oldParent)} to under {name(newParent)}.
        </>
      );
      break;
    case "moved-away": {
      const moved = mark.partner ? tree.marks.get(mark.partner)?.newNode : undefined;
      story = (
        <>
          This is where {name(node)} was in the old version. It's now under {name(moved && findParent(newRoot, moved.uid))}.
          {mark.partner && (
            <div>
              <button className="small" onClick={() => goTo(mark.partner!)}>
                Show where it is now
              </button>
            </div>
          )}
        </>
      );
      break;
    }
  }
  const nesting =
    mark.nesting === "wrapped" ? <>Now inside {name(newParent)}, which was added around it.</> : mark.nesting === "unwrapped" ? <>No longer inside {name(oldParent)}, which was removed.</> : null;

  return (
    <>
      <div className={`inspector-title cat-${category.toLowerCase()}`}>
        <span className="bt-node-icon">{iconFor(node.type, category, modelFor(node, models)?.metadata?.icon)}</span>
        <div>
          <div className="inspector-type">{node.type === "SubTree" ? (node.attrs.ID ?? "SubTree") : node.type}</div>
          {node.attrs.name && <div className="muted">{node.attrs.name}</div>}
        </div>
      </div>
      <div className="compare-kind">
        <span className={`diff-chip k-${mark.kind}`}>{KIND_TEXT[mark.kind]}</span>
        {mark.edited && mark.kind !== "changed" && <span className="diff-chip k-changed">Edited</span>}
        {mark.nesting && <span className="diff-chip">{mark.nesting}</span>}
      </div>
      {story && <p className="compare-story">{story}</p>}
      {nesting && <p className="compare-story">{nesting}</p>}
      {mark.innerChange && (
        <p className="compare-story">
          The tree it runs, <strong>{node.attrs.ID}</strong>, changed.{" "}
          <button className="small" onClick={() => showDiffTree(node.attrs.ID!)}>
            Show those changes
          </button>
        </p>
      )}
      <AttrTable mark={mark} />
      {d.status === "loading" && <p className="muted small-text">Updating…</p>}
    </>
  );
}

/** Every attribute of the node, before and after; changed rows stand out. */
function AttrTable({ mark }: { mark: Mark }) {
  const before = mark.kind === "added" ? undefined : mark.oldNode;
  const after = mark.kind === "removed" || mark.kind === "moved-away" ? undefined : mark.newNode;
  const rows: { key: string; old?: string; new?: string }[] = [];
  if (before && after && before.type !== after.type) rows.push({ key: "type", old: before.type, new: after.type });
  for (const key of new Set([...Object.keys(before?.attrs ?? {}), ...Object.keys(after?.attrs ?? {})])) {
    rows.push({ key, old: before?.attrs[key], new: after?.attrs[key] });
  }
  if (!rows.length) return <p className="muted small-text">No attributes.</p>;
  const both = !!before && !!after;
  return (
    <table className="compare-attrs">
      <thead>
        <tr>
          <th>Attribute</th>
          {before && <th>{both ? "Before" : "Value"}</th>}
          {after && <th>{both ? "After" : "Value"}</th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const changed = both && r.old !== r.new;
          return (
            <tr key={r.key} className={changed ? "changed" : ""}>
              <td className="mono">{r.key}</td>
              {before && <td className={`mono ${changed ? "old" : ""}`}>{r.old ?? <span className="muted">—</span>}</td>}
              {after && <td className={`mono ${changed ? "new" : ""}`}>{r.new ?? <span className="muted">—</span>}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TreeChanges({ tree }: { tree: MergedTree }) {
  const { diff: t } = tree;
  const counts = countMarks(tree);
  const ports = (p: { name: string; direction: string }[] = []) => p.map((x) => `${x.name} (${x.direction})`).join(", ") || "none";
  const facts: ReactNode[] = [];
  if (t.status === "added") facts.push(<>This tree is new in {t.new!.file}.</>);
  if (t.status === "removed") facts.push(<>This tree was deleted from {t.old!.file}.</>);
  if (t.meta.id)
    facts.push(
      <>
        Renamed from <strong>{t.meta.id.old}</strong>.
      </>,
    );
  if (t.meta.file)
    facts.push(
      <>
        Moved from <span className="mono">{t.meta.file.old}</span> to <span className="mono">{t.meta.file.new}</span>.
      </>,
    );
  if (t.meta.description) facts.push(<>Its description changed from “{t.meta.description.old ?? ""}” to “{t.meta.description.new ?? ""}”.</>);
  if (t.meta.ports)
    facts.push(
      <>
        Its ports changed: {ports(t.old?.ports)} → {ports(t.new?.ports)}.
      </>,
    );
  for (const [k, v] of Object.entries(t.meta.attrs))
    facts.push(
      <>
        <span className="mono">{k}</span>: {v.old ?? "—"} → {v.new ?? "—"}
      </>,
    );
  return (
    <>
      <div className="inspector-title cat-subtree">
        <span className="bt-node-icon">▣</span>
        <div>
          <div className="inspector-type">{tree.key}</div>
          <div className="muted small-text">{(t.new ?? t.old)!.file}</div>
        </div>
      </div>
      <div className="compare-kind">
        <span className={`diff-chip st-${t.status}`}>{t.status}</span>
      </div>
      {facts.map((f, i) => (
        <p key={i} className="compare-story">
          {f}
        </p>
      ))}
      {t.status !== "unchanged" && (
        <ul className="compare-counts">
          <li className="k-added">{counts.added} added</li>
          <li className="k-removed">{counts.removed} removed</li>
          <li className="k-changed">{counts.edited} edited</li>
          <li className="k-moved">{counts.moved} moved</li>
        </ul>
      )}
      <p className="muted small-text">
        Select a highlighted node to see exactly what changed. <kbd>N</kbd> and <kbd>Shift+N</kbd> step through the changes.
      </p>
    </>
  );
}
