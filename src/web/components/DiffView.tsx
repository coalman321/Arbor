// Compare mode's screen: revision pickers and the changed trees on the left, the merged tree in the
// middle, and what changed about the selected node on the right. Nothing here can be edited.

import { Background, Controls, ReactFlow, useReactFlow } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  categoryOf,
  findParent,
  iconFor,
  layoutTree,
  modelFor,
  nodeLabel,
  sortTreeDiffs,
  treeKey,
  type BTNode,
  type Mark,
  type MarkKind,
  type MergedTree,
  type NodeModel,
  type TreeDefDiff,
  type TreeDefStatus,
} from "@coalman321/arborist";
import {
  closeCompare,
  compare,
  mergedModels,
  reloadGitInfo,
  showMoreHistory,
  resolveDiffPath,
  showDiffTree,
  stepChange,
  useStops,
  type DiffState,
  type GitRevs,
} from "../diff.ts";
import { layoutGraph, type GraphRow } from "../git_graph.ts";
import { select, useStore } from "../store.ts";
import {
  boxesByPath,
  diffEdgeClass,
  diffLinesFor,
  edgeTypes,
  flowEdges,
  flowNodes,
  nodeRect,
  nodeTypes,
  ViewerContext,
  type BTFlowEdge,
  type BTFlowNode,
} from "@coalman321/arborist/react";
import { diffViewer } from "../viewer.ts";
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

type RefKind = "head" | "branch" | "tag" | "remote";

/** git log's decorations as labels: "HEAD -> main" is the checked-out branch; "tag: v1" a tag. */
function refLabels(refs: string[], git: GitRevs): { text: string; kind: RefKind }[] {
  const out: { text: string; kind: RefKind }[] = [];
  for (const r of refs) {
    if (r.startsWith("HEAD -> ")) out.push({ text: r.slice("HEAD -> ".length), kind: "head" });
    else if (r === "HEAD") out.push({ text: "HEAD", kind: "head" });
    else if (r.startsWith("tag: ")) out.push({ text: r.slice("tag: ".length), kind: "tag" });
    else if (r.endsWith("/HEAD")) continue;
    else out.push({ text: r, kind: git.branches.includes(r) ? "branch" : "remote" });
  }
  // A remote branch at the same commit as its local one ("origin/x" next to "x") adds nothing.
  const local = new Set(out.filter((l) => l.kind !== "remote" && l.kind !== "tag").map((l) => l.text));
  return out.filter((l) => l.kind !== "remote" || !local.has(l.text.slice(l.text.indexOf("/") + 1)));
}

const LANE_W = 14;
const ROW_H = 42;
const GRAPH_PAD = 10;
const LANE_COLORS = 6;

const laneX = (lane: number) => GRAPH_PAD + lane * LANE_W;

/** A line from (x1, y1) down to (x2, y2): straight, or an S-curve when it changes lanes. */
function segmentPath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const ym = (y1 + y2) / 2;
  return `M ${x1} ${y1} C ${x1} ${ym}, ${x2} ${ym}, ${x2} ${y2}`;
}

/** One row of the history graph: the lines through it and the commit's dot. */
function GraphCell({ row, width, head, selected, joinAbove }: { row: GraphRow; width: number; head: boolean; selected: boolean; joinAbove: boolean }) {
  const mid = ROW_H / 2;
  const x = laneX(row.lane);
  return (
    <svg className="graph-cell" width={GRAPH_PAD * 2 + (width - 1) * LANE_W} height={ROW_H} aria-hidden>
      {joinAbove && <path d={segmentPath(x, 0, x, mid)} className="graph-line graph-join" />}
      {row.top.map((s, i) => (
        <path key={`t${i}`} d={segmentPath(laneX(s.from), 0, laneX(s.to), mid)} className={`graph-line lane-${s.color % LANE_COLORS}`} />
      ))}
      {row.bottom.map((s, i) => (
        <path key={`b${i}`} d={segmentPath(laneX(s.from), mid, laneX(s.to), ROW_H)} className={`graph-line lane-${s.color % LANE_COLORS}`} />
      ))}
      <circle cx={x} cy={mid} r={selected ? 5.5 : 4} className={`graph-dot lane-${row.lane % LANE_COLORS} ${head ? "head" : ""} ${selected ? "selected" : ""}`} />
    </svg>
  );
}

/**
 * The checkout's history as a graph, like VS Code's. Clicking a commit compares the current files
 * with the project as it was then. A filter hides the graph, since its lines only make sense whole.
 */
function HistoryPanel() {
  const d = useStore((s) => s.diff!);
  const { git, base } = d;
  const graph = useMemo(() => layoutGraph(git.commits), [git.commits]);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const rows = git.commits
    .map((c, i) => ({ c, row: graph.rows[i] }))
    .filter(({ c }) => !q || c.sha.startsWith(q) || `${c.subject} ${c.author} ${c.refs.join(" ")}`.toLowerCase().includes(q));
  const width = Math.max(1, graph.width);

  return (
    <section className="panel history-panel">
      <header className="panel-header">
        <span>History</span>
        <button className="icon-button" onClick={() => void reloadGitInfo()} title="Reload the history">
          ↻
        </button>
      </header>
      <div className="palette-search">
        <input placeholder="Filter commits…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter commits" />
      </div>
      <div className="panel-body history-body" role="listbox" aria-label="Version to compare your files with">
        {!q && (
          <div className="history-row current" title="Your tree files as saved on disk: always the new side of the comparison">
            <svg className="graph-cell" width={GRAPH_PAD * 2 + (width - 1) * LANE_W} height={ROW_H} aria-hidden>
              {git.commits.length > 0 && <path d={segmentPath(laneX(0), ROW_H / 2, laneX(0), ROW_H)} className="graph-line graph-join" />}
              <circle cx={laneX(0)} cy={ROW_H / 2} r={4.5} className="graph-dot current" />
            </svg>
            <div className="history-text">
              <div className="history-subject">
                Current files <span className="side-chip new">new</span>
              </div>
              <div className="history-detail muted small-text">on disk{git.dirty ? " · uncommitted changes" : ""}</div>
            </div>
          </div>
        )}
        {rows.map(({ c, row }, i) => {
          const selected = c.sha === base;
          const labels = refLabels(c.refs, git);
          return (
            <div
              key={c.sha}
              role="option"
              aria-selected={selected}
              className={`history-row ${selected ? "selected" : ""}`}
              onClick={() => !selected && void compare(c.sha)}
              title={`${c.subject}\n${c.short} · ${c.author} · ${new Date(c.date).toLocaleString()}\n\nClick to compare your current files with this version`}
            >
              {!q && <GraphCell row={row} width={width} head={c.sha === git.head} selected={selected} joinAbove={i === 0} />}
              <div className="history-text">
                <div className="history-subject">
                  <span className="history-message">{c.subject}</span>
                  {labels.map((l) => (
                    <span key={l.text} className={`ref-chip ${l.kind}`} title={l.kind === "head" ? `${l.text} (checked out)` : l.text}>
                      {l.text}
                    </span>
                  ))}
                  {selected && <span className="side-chip old">old</span>}
                </div>
                <div className="history-detail muted small-text">
                  {c.short} · {c.author} · {ago(c.date)}
                </div>
              </div>
            </div>
          );
        })}
        {q && rows.length === 0 && <p className="muted pad">No commits match.</p>}
        {!q && git.more && (
          <button className="link history-more" onClick={showMoreHistory}>
            Show older commits
          </button>
        )}
        {git.commits.length === 0 && <p className="muted pad">No commit has touched the trees yet.</p>}
        {!q && !git.more && git.commits.length > 0 && <p className="muted small-text history-end">Only commits that change the trees or node spec are listed.</p>}
      </div>
    </section>
  );
}

function CompareSidebar() {
  const d = useStore((s) => s.diff!);
  const dirty = useStore((s) => Object.values(s.files).filter((f) => f.dirty).length);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const sorted = useMemo(() => sortTreeDiffs(d.trees), [d.trees]);
  const changed = sorted.filter((t) => t.status !== "unchanged");
  const unchanged = sorted.filter((t) => t.status === "unchanged");
  const baseCommit = d.git.commits.find((c) => c.sha === d.base);

  return (
    <aside className="sidebar compare-sidebar">
      <section className="panel compare-summary">
        <header className="panel-header">
          <span>Compare</span>
          <button className="small" onClick={closeCompare} title="Back to editing">
            Done
          </button>
        </header>
        <div className="compare-direction">
          <div title={baseCommit ? `${baseCommit.subject} (${baseCommit.short})` : d.base}>
            <span className="side-chip old">old</span> {baseCommit?.subject ?? d.old?.label ?? d.base.slice(0, 7)}{" "}
            <span className="muted small-text">{baseCommit?.short}</span>
          </div>
          <div>
            <span className="side-chip new">new</span> Current files
          </div>
        </div>
        {dirty > 0 && (
          <p className="compare-note small-text">
            “Current files” means what's saved on disk: unsaved edits in {dirty} file{dirty === 1 ? "" : "s"} aren't included.
          </p>
        )}
      </section>
      <section className="panel compare-trees">
        <header className="panel-header">
          <span>{d.status === "ready" ? `${changed.length} tree${changed.length === 1 ? "" : "s"} changed` : "Trees"}</span>
        </header>
        <div className="panel-body">
          {d.status === "loading" && d.trees.length === 0 && <p className="muted pad">Reading both versions…</p>}
          {d.status === "error" && <p className="pad compare-error">{d.error}</p>}
          {d.status === "ready" && changed.length === 0 && <p className="muted pad">Your trees are the same as in this version.</p>}
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
      <HistoryPanel />
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
            linesFor: diffLinesFor(merged),
          })
        : [],
    [tree, defs, expanded, dir, decoratorFrames, models, merged],
  );
  const byPath = useMemo(() => new Map(items.map((i) => [i.path, i])), [items]);
  // Nodes drawn inside another (folded conditions) are revealed by the box that shows them.
  const boxFor = useMemo(() => boxesByPath(items), [items]);
  const nodes = useMemo(() => flowNodes(items, { models, dir, liveMain: false, selection }), [items, models, dir, selection]);
  const edges = useMemo(
    () => flowEdges(items, { dir, liveMain: false, edgeClass: diffEdgeClass(merged) }),
    [items, dir, merged],
  );

  const center = (path: string) => {
    const it = boxFor.get(path);
    if (!it) return false;
    const r = nodeRect(it, dir);
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
    <div className={`canvas arbor-viewer compare-canvas ${d.status === "loading" ? "is-loading" : ""}`}>
      <ViewerContext.Provider value={diffViewer}>
        <ReactFlow<BTFlowNode, BTFlowEdge>
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
      </ViewerContext.Provider>
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
