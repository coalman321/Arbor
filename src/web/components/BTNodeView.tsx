import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { memo, type MouseEvent, type ReactNode } from "react";
import { isBlackboardRef, type BTNode } from "../../shared/model.ts";
import { conditionText, type CondPart, type FoldedCondition, type LayoutItem } from "../layout.ts";
import { openTree, select, statusClass, toggleExpanded, useStore, type StatusInfo } from "../store.ts";
import { decoratorHint } from "../edge_hints.ts";
import { showDiffTree, useDiffMark } from "../diff.ts";
import type { Mark } from "../diff_view.ts";
import { flavorOf, iconFor } from "./icons.ts";

export interface BTNodeData extends Record<string, unknown> {
  item: LayoutItem;
  category: string;
  /** The node type's custom icon, if its spec sets one. */
  icon?: string;
  problems: { severity: string; message: string }[];
  /** Problems of nodes drawn inside this one (its condition), by node uid. */
  foldedProblems: Record<string, string[]>;
  dir: "TB" | "LR";
  /** True when the tab shows the tree the robot is running, so statuses are per instance. */
  liveMain: boolean;
}

export type BTFlowNode = Node<BTNodeData, "bt" | "frame" | "window">;

export function useNodeStatus(item: LayoutItem, liveMain: boolean): StatusInfo | undefined {
  return useStore((s) => (liveMain ? s.live.statusByPath[item.path] : s.live.statusByDef[`${item.treeId}:${item.node.uid}`]));
}

const BRANCH_PLACEHOLDER: Record<string, string> = { IfThenElse: "if", WhileDoElse: "while" };

function title(node: BTNode): string {
  return node.type === "SubTree" ? (node.attrs.ID ?? "SubTree") : node.type;
}

interface CondContext {
  treeId: string;
  liveMain: boolean;
  problems: Record<string, string[]>;
}

/** One clickable piece of a folded condition, standing for the node at `path`. */
function CondToken({ path, node, ctx, className, children }: { path: string; node: BTNode; ctx: CondContext; className: string; children: ReactNode }) {
  const status = useStore((s) => (ctx.liveMain ? s.live.statusByPath[path] : s.live.statusByDef[`${ctx.treeId}:${node.uid}`]));
  const selected = useStore((s) => (s.diff ? s.diff.selection : s.selection) === path);
  const mark = useDiffMark(ctx.treeId, node.uid);
  const problems = ctx.problems[node.uid];
  const cls = ["cond-token", "nodrag", className, statusClass(status), diffClass(mark), selected ? "selected" : "", problems ? "has-problem" : ""].join(" ");
  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    select(path);
  };
  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (useStore.getState().diff) return; // nothing to edit in compare mode
    useStore.setState({ selection: path, menu: { x: e.clientX, y: e.clientY, path }, picker: null });
  };
  return (
    <span className={cls} onClick={onClick} onContextMenu={onContextMenu} title={[node.type, ...(problems ?? [])].join("\n")}>
      {children}
    </span>
  );
}

function CondPartView({ part, ctx, nested }: { part: CondPart; ctx: CondContext; nested: boolean }) {
  switch (part.kind) {
    case "script":
      return <span className="cond-script">{part.text || <em className="muted">no condition</em>}</span>;
    case "leaf":
      return (
        <CondToken path={part.path} node={part.node} ctx={ctx} className={part.script ? "cond-leaf cond-script" : "cond-leaf"}>
          {part.label}
          {part.args && <span className="cond-args">({part.args})</span>}
        </CondToken>
      );
    case "not":
      return (
        <>
          <CondToken path={part.path} node={part.node} ctx={ctx} className="cond-op">
            ¬
          </CondToken>
          <CondPartView part={part.child} ctx={ctx} nested />
        </>
      );
    case "group": {
      const open = !part.op ? `${part.node.type}(` : nested && part.children.length > 1 ? "(" : "";
      const close = open ? ")" : "";
      return (
        <>
          {open && (
            <CondToken path={part.path} node={part.node} ctx={ctx} className="cond-op">
              {open}
            </CondToken>
          )}
          {part.children.map((c, i) => (
            <span key={i} className="cond-seq">
              {i > 0 && (
                <CondToken path={part.path} node={part.node} ctx={ctx} className="cond-op">
                  {part.op ?? ","}
                </CondToken>
              )}
              <CondPartView part={c} ctx={ctx} nested />
            </span>
          ))}
          {close && (
            <CondToken path={part.path} node={part.node} ctx={ctx} className="cond-op">
              {close}
            </CondToken>
          )}
        </>
      );
    }
  }
}

function ConditionRow({ condition, ctx }: { condition: FoldedCondition; ctx: CondContext }) {
  return (
    <div className="bt-node-cond" title={`${condition.keyword} ${conditionText(condition.part)}`}>
      <span className="cond-keyword">{condition.keyword}</span>
      <span className="cond-body">
        <CondPartView part={condition.part} ctx={ctx} nested={false} />
      </span>
    </div>
  );
}

/** CSS classes for a node's change in compare mode. */
function diffClass(mark: Mark | undefined): string {
  if (!mark) return "";
  return [mark.kind === "same" ? "" : `diff-${mark.kind}`, mark.edited ? "diff-edited" : "", mark.innerChange ? "diff-inner" : ""].join(" ");
}

/** What happened to a node, as the short tag on its corner. */
function diffTag(mark: Mark): string | null {
  switch (mark.kind) {
    case "added":
      return "added";
    case "removed":
      return "removed";
    case "moved-away":
      return "moved away";
    case "moved":
      return mark.reordered ? "reordered" : "moved";
    case "changed":
      return "edited";
  }
  return mark.nesting ?? (mark.innerChange ? "contents changed" : null);
}

function DiffTag({ mark }: { mark: Mark }) {
  const text = diffTag(mark);
  return text ? <span className="bt-node-diff">{text + (mark.kind === "moved" && mark.edited ? " · edited" : "")}</span> : null;
}

const shown = (v: string) => (v === "" ? '""' : v);

/** A node's content: header, name, condition, ports. Shared by plain nodes and frame headers. */
function NodeBody({ data, status, mark }: { data: BTNodeData; status: StatusInfo | undefined; mark?: Mark }) {
  const { item, category, icon, problems, foldedProblems, liveMain } = data;
  const { node } = item;
  const name = node.attrs.name && node.attrs.name !== title(node) ? node.attrs.name : null;
  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.length - errors;
  const flavor = flavorOf(node.type);
  return (
    <>
      <div className="bt-node-header">
        <span className="bt-node-icon" aria-hidden>
          {iconFor(node.type, category, icon)}
        </span>
        <span className="bt-node-title">{title(node)}</span>
        {flavor && <span className="bt-node-flavor">{flavor}</span>}
        {errors > 0 && <span className="badge badge-error">{errors}</span>}
        {warnings > 0 && errors === 0 && <span className="badge badge-warning">{warnings}</span>}
      </div>
      {name && <div className="bt-node-name">{name}</div>}
      {item.hint && (
        <div className="bt-node-hint" title={decoratorHint(node)?.help}>
          {item.hint}
        </div>
      )}
      {item.condition && <ConditionRow condition={item.condition} ctx={{ treeId: item.treeId, liveMain, problems: foldedProblems }} />}
      {!item.condition && item.node.type in BRANCH_PLACEHOLDER && (
        <div className="bt-node-cond empty">
          <span className="cond-keyword">{BRANCH_PLACEHOLDER[item.node.type]}</span>
          <span className="muted">drop a condition here</span>
        </div>
      )}
      {item.lines.length > 0 && (
        <div className="bt-node-ports">
          {item.lines.map((l) => (
            <div key={l.key} className={`bt-node-port ${l.change ? `diff-${l.change}` : ""}`}>
              <span className="k">{l.key}</span>
              {l.old !== undefined && <span className="v old">{shown(l.old)}</span>}
              <span className={isBlackboardRef(l.value) ? "v bb" : "v"}>{shown(l.value)}</span>
            </div>
          ))}
          {item.hiddenLines > 0 && <div className="bt-node-more">+{item.hiddenLines} more</div>}
        </div>
      )}
      {node.type === "SubTree" && (
        <button
          className="bt-node-expand nodrag"
          title={item.expanded ? "Collapse subtree" : "Show subtree inline"}
          onClick={(e) => {
            e.stopPropagation();
            toggleExpanded(item.path);
          }}
        >
          {item.expanded ? "−" : "+"}
        </button>
      )}
      {status && (status.status !== "IDLE" || status.done) && <span className="bt-node-status">{status.done ? status.last : status.status}</span>}
      {mark && <DiffTag mark={mark} />}
    </>
  );
}

function useNodeClasses(data: BTNodeData, selected: boolean, status: StatusInfo | undefined, mark: Mark | undefined, base: string): string {
  const hint = useStore((s) => (s.dropHint?.path === data.item.path ? s.dropHint.zone : null));
  return [
    base,
    `cat-${data.category.toLowerCase()}`,
    selected ? "selected" : "",
    data.item.readOnly ? "readonly" : "",
    statusClass(status),
    diffClass(mark),
    hint ? `drop-${hint}` : "",
  ].join(" ");
}

function BTNodeViewImpl({ data, selected }: NodeProps<BTFlowNode>) {
  const { item, problems, dir, liveMain } = data;
  const status = useNodeStatus(item, liveMain);
  const mark = useDiffMark(item.treeId, item.node.uid);
  const cls = useNodeClasses(data, selected, status, mark, "bt-node");
  return (
    <div className={cls} style={{ width: item.w }} title={problems.map((p) => p.message).join("\n") || undefined}>
      <Handle type="target" position={dir === "TB" ? Position.Top : Position.Left} isConnectable={false} />
      <NodeBody data={data} status={status} mark={mark} />
      <Handle type="source" position={dir === "TB" ? Position.Bottom : Position.Right} isConnectable={false} />
    </div>
  );
}

export const BTNodeView = memo(BTNodeViewImpl);

/**
 * A decorator drawn around its child's subtree: its own content is the header, and the rest of the
 * frame is see-through (and click-through) so the nodes inside stay usable.
 */
function FrameViewImpl({ data, selected }: NodeProps<BTFlowNode>) {
  const { item, problems, dir, liveMain } = data;
  const status = useNodeStatus(item, liveMain);
  const mark = useDiffMark(item.treeId, item.node.uid);
  const cls = useNodeClasses(data, selected, status, mark, `bt-frame ${dir === "LR" ? "lr" : "tb"}`);
  const header = dir === "TB" ? { height: item.frame!.headerH } : { width: item.frame!.headerW };
  return (
    <div className={cls} style={{ width: item.w, height: item.h }}>
      <Handle type="target" position={dir === "TB" ? Position.Top : Position.Left} isConnectable={false} />
      <div className="bt-frame-header" style={header} title={problems.map((p) => p.message).join("\n") || undefined}>
        <NodeBody data={data} status={status} mark={mark} />
      </div>
      <Handle type="source" position={dir === "TB" ? Position.Bottom : Position.Right} isConnectable={false} />
    </div>
  );
}

export const FrameView = memo(FrameViewImpl);

/**
 * The locked frame around an expanded SubTree's nodes: they belong to another tree (and file), so
 * they can't be edited here. The header names that tree and opens it.
 */
function WindowViewImpl({ data }: NodeProps<BTFlowNode>) {
  const { item, dir } = data;
  const win = item.window!;
  const comparing = useStore((s) => !!s.diff);
  const header = dir === "TB" ? { height: item.frame!.headerH } : { width: item.frame!.headerW };
  return (
    <div className={`bt-window ${dir === "LR" ? "lr" : "tb"}`} style={{ width: item.w, height: item.h }}>
      <Handle type="target" position={dir === "TB" ? Position.Top : Position.Left} isConnectable={false} />
      <div
        className="bt-window-header"
        style={header}
        title={`These steps belong to the tree "${win.treeId}" (${win.file}). Open it to change them.`}
      >
        <span className="bt-window-lock" aria-hidden>
          🔒
        </span>
        <span className="bt-window-title">
          <strong>{win.treeId}</strong> <span className="muted">· from {win.file.split("/").pop()}</span>
        </span>
        <button
          className="small nodrag"
          onClick={(e) => {
            e.stopPropagation();
            if (comparing) showDiffTree(win.treeId);
            else openTree(win.treeId);
          }}
        >
          {comparing ? "Show this tree" : "Open to edit"}
        </button>
      </div>
      <Handle type="source" position={dir === "TB" ? Position.Bottom : Position.Right} isConnectable={false} />
    </div>
  );
}

export const WindowView = memo(WindowViewImpl);
