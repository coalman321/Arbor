import { useMemo, useState } from "react";
import {
  categoryOf,
  CONDITION_FIRST,
  enumForType,
  findEnumValue,
  iconFor,
  isBlackboardRef,
  literalProblem,
  modelFor,
  nodeStatus,
  PRE_POST_CONDITIONS,
  RESERVED_ATTRS,
  type BTNode,
  type EnumModel,
  type PortDirection,
  type PortModel,
  type TreeDef,
} from "@coalman321/arborist";
import {
  deleteSelected,
  duplicateSelected,
  moveSelected,
  unwrapSelected,
} from "../actions.ts";
import {
  editRoot,
  editTree,
  openTree,
  resolvePath,
  select,
  setMainTree,
  togglePanel,
  treesUsing,
  useDiagnostics,
  useEnums,
  useModels,
  useStore,
} from "../store.ts";
import { blackboardKeys, blackboardKeyTypes, mapNode } from "../tree_ops.ts";

const DIR_ARROW: Record<PortDirection, string> = { input: "→", output: "←", inout: "↔" };
const DIR_TITLE: Record<PortDirection, string> = { input: "input port", output: "output port", inout: "bidirectional port" };
const SCRIPT_PORTS = new Set(["code", "if"]);


function setAttr(attrs: Record<string, string>, key: string, value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  let done = false;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === key) {
      done = true;
      if (value !== undefined) out[k] = value;
    } else out[k] = v;
  }
  if (!done && value !== undefined) out[key] = value;
  return out;
}

export function Inspector() {
  const active = useStore((s) => s.active);
  const selection = useStore((s) => s.selection);
  const trees = useStore((s) => s.trees);
  if (!active || !trees[active]) {
    return (
      <aside className="inspector">
        <button className="icon-button inspector-hide" onClick={() => togglePanel("right")} title="Fold the properties panel (Ctrl+Alt+B)">
          ▸
        </button>
        <p className="muted pad">Open a tree to see its properties.</p>
      </aside>
    );
  }
  const r = selection ? resolvePath(trees, active, selection) : null;
  return (
    <aside className="inspector">
        <button className="icon-button inspector-hide" onClick={() => togglePanel("right")} title="Fold the properties panel (Ctrl+Alt+B)">
          ▸
        </button>
      {r ? <NodeInspector key={selection!} path={selection!} tree={r.tree} node={r.node} readOnly={r.readOnly} /> : <TreeInspector tree={trees[active]} />}
    </aside>
  );
}

function NodeInspector({ path, tree, node, readOnly }: { path: string; tree: TreeDef; node: BTNode; readOnly: boolean }) {
  const models = useModels();
  const enums = useEnums();
  const trees = useStore((s) => s.trees);
  const liveTree = useStore((s) => (s.live.state === "connected" || s.live.state === "replay" ? s.live.treeId : undefined));
  const active = useStore((s) => s.active)!;
  const diagnostics = useDiagnostics();
  const model = modelFor(node, models);
  const category = categoryOf(node, models);
  const status = useStore((s) => nodeStatus(s.live, path, tree.id, node.uid, liveTree === active));
  const problems = diagnostics.filter((d) => d.treeId === tree.id && d.nodeUid === node.uid);
  const bbKeys = useMemo(() => blackboardKeys(tree.root), [tree.root]);
  const [showAdvanced, setShowAdvanced] = useState(PRE_POST_CONDITIONS.some((c) => node.attrs[c.name] !== undefined));

  const update = (key: string, value: string | undefined) =>
    editRoot(tree.id, (r) => (r ? mapNode(r, node.uid, (n) => ({ ...n, attrs: setAttr(n.attrs, key, value) })) : r), `${path}:${key}`);

  const ports = model?.ports ?? [];
  const portNames = new Set(ports.map((p) => p.name));
  const extra = Object.keys(node.attrs).filter((k) => !RESERVED_ATTRS.has(k) && !portNames.has(k));
  const isSubTree = node.type === "SubTree";
  const target = isSubTree ? trees[node.attrs.ID ?? ""] : undefined;

  return (
    <div className="inspector-body">
      <div className={`inspector-title cat-${category.toLowerCase()}`}>
        <span className="bt-node-icon">{iconFor(node.type, category, model?.metadata?.icon)}</span>
        <div>
          <div className="inspector-type">{isSubTree ? `SubTree · ${node.attrs.ID ?? "?"}` : node.type}</div>
          <div className="muted small-text">
            {category}
            {model?.source === "builtin" ? " · builtin" : model?.source === "spec" ? " · from node spec" : ""}
          </div>
        </div>
      </div>
      {model?.description && <p className="inspector-desc">{model.description}</p>}
      {model?.metadata && Object.keys(model.metadata).some((k) => k !== "icon") && (
        <div className="meta">
          {Object.entries(model.metadata)
            .filter(([k]) => k !== "icon")
            .map(([k, v]) => (
              <span key={k} className="chip">
                {k}: {v}
              </span>
            ))}
        </div>
      )}

      {readOnly && (
        <div className="notice">
          This node belongs to <strong>{tree.id}</strong>, shown inline.{" "}
          <button className="link" onClick={() => openTree(tree.id, node.uid)}>
            Open {tree.id} to edit it
          </button>
        </div>
      )}

      {status && (
        <div className={`live-status is-${status.status.toLowerCase()}`}>
          <span>● {status.status}</span>
          {status.status === "IDLE" && status.last !== "IDLE" && <span className="muted">last: {status.last}</span>}
          <span className="muted">{new Date(status.t).toLocaleTimeString()}</span>
        </div>
      )}

      {problems.length > 0 && (
        <ul className="problems-inline">
          {problems.map((p, i) => (
            <li key={i} className={`sev-${p.severity}`}>
              {p.message}
            </li>
          ))}
        </ul>
      )}

      {CONDITION_FIRST[node.type] && <Branches node={node} path={path} />}

      <fieldset disabled={readOnly}>
        <label className="field">
          <span className="field-label">Name</span>
          <input
            value={node.attrs.name ?? ""}
            placeholder={isSubTree ? (node.attrs.ID ?? "") : node.type}
            onChange={(e) => update("name", e.target.value || undefined)}
          />
        </label>

        {isSubTree && (
          <>
            <label className="field">
              <span className="field-label">Tree</span>
              <div className="row">
                <select value={node.attrs.ID ?? ""} onChange={(e) => update("ID", e.target.value)}>
                  {!target && <option value={node.attrs.ID ?? ""}>{node.attrs.ID ?? "(none)"} (missing)</option>}
                  {Object.keys(trees)
                    .filter((id) => id !== tree.id)
                    .sort()
                    .map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                </select>
                {target && (
                  <button type="button" onClick={() => openTree(target.id)}>
                    Open
                  </button>
                )}
              </div>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={node.attrs._autoremap === "true"}
                onChange={(e) => update("_autoremap", e.target.checked ? "true" : undefined)}
              />
              <span>
                Auto-remap <span className="muted">(ports not listed below map to same-named entries of the parent blackboard)</span>
              </span>
            </label>
          </>
        )}

        {(ports.length > 0 || isSubTree) && (
          <h4 className="section-title">
            {isSubTree ? "Port remapping" : "Ports"}
            {isSubTree && target && ports.length === 0 && <span className="muted"> — {target.id} declares no ports</span>}
          </h4>
        )}
        {ports.map((p) => (
          <PortField
            key={p.name}
            port={p}
            value={node.attrs[p.name]}
            onChange={(v) => update(p.name, v)}
            bbKeys={bbKeys}
            enums={enums}
            subtreeAuto={isSubTree && node.attrs._autoremap === "true"}
          />
        ))}

        {extra.length > 0 && (
          <>
            <h4 className="section-title">{isSubTree && ports.length === 0 ? "" : "Other attributes"}</h4>
            {extra.map((k) => (
              <div key={k} className="field">
                <span className="field-label">
                  {k} {!(isSubTree && ports.length === 0) && <span className="badge badge-warning">not a port</span>}
                </span>
                <div className="row">
                  <input value={node.attrs[k]} onChange={(e) => update(k, e.target.value)} />
                  <button type="button" className="icon-button" title="Remove" onClick={() => update(k, undefined)}>
                    ×
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
        {isSubTree && <AddRemap onAdd={(k, v) => update(k, v)} existing={node.attrs} />}

        <button type="button" className="disclosure" onClick={() => setShowAdvanced(!showAdvanced)}>
          {showAdvanced ? "▾" : "▸"} Pre/post conditions
        </button>
        {showAdvanced &&
          PRE_POST_CONDITIONS.map((c) => (
            <label key={c.name} className="field">
              <span className="field-label" title={c.help}>
                {c.name}
              </span>
              <input
                className="mono"
                value={node.attrs[c.name] ?? ""}
                placeholder={c.help}
                onChange={(e) => update(c.name, e.target.value || undefined)}
              />
            </label>
          ))}
      </fieldset>

      {!readOnly && (
        <div className="inspector-actions">
          <button onClick={() => moveSelected(-1)} title="Move before previous sibling (Alt+↑)">
            ↑ Move
          </button>
          <button onClick={() => moveSelected(1)} title="Move after next sibling (Alt+↓)">
            ↓ Move
          </button>
          <button onClick={duplicateSelected} title="Ctrl+D">
            Duplicate
          </button>
          <button onClick={(e) => useStore.setState({ picker: { x: e.clientX, y: e.clientY, mode: "wrap", treeId: tree.id, uid: node.uid } })}>
            Wrap in…
          </button>
          <button onClick={(e) => useStore.setState({ picker: { x: e.clientX, y: e.clientY, mode: "replace", treeId: tree.id, uid: node.uid } })}>
            Change type…
          </button>
          {node.children.length > 0 && (
            <button onClick={unwrapSelected} title="Remove this node, keep its children">
              Unwrap
            </button>
          )}
          <button onClick={() => useStore.setState({ dialog: { kind: "newTree", extractFrom: { treeId: tree.id, uid: node.uid } } })}>
            Extract to SubTree…
          </button>
          <button className="danger" onClick={deleteSelected} title="Delete node and its children (Del)">
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

/** IfThenElse/WhileDoElse: which child plays which role, since the condition is drawn inside the node. */
function Branches({ node, path }: { node: BTNode; path: string }) {
  const labels = CONDITION_FIRST[node.type];
  const prefix = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  return (
    <div className="branches">
      {labels.map((label, i) => {
        const child = node.children[i];
        const optional = i === labels.length - 1;
        return (
          <div key={label} className="branch-row">
            <span className="cond-keyword">{label}</span>
            {child ? (
              <button className="link" onClick={() => select(prefix + child.uid)}>
                {child.attrs.name || (child.type === "SubTree" ? child.attrs.ID : child.type)}
              </button>
            ) : (
              <span className={optional ? "muted" : "sev-error"}>{optional ? "none (optional)" : "missing"}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function AddRemap({ onAdd, existing }: { onAdd: (k: string, v: string) => void; existing: Record<string, string> }) {
  const [key, setKey] = useState("");
  const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && existing[key] === undefined && !RESERVED_ATTRS.has(key);
  return (
    <div className="row add-remap">
      <input placeholder="subtree port" value={key} onChange={(e) => setKey(e.target.value)} />
      <button
        type="button"
        disabled={!valid}
        onClick={() => {
          onAdd(key, `{${key}}`);
          setKey("");
        }}
      >
        + Remap
      </button>
    </div>
  );
}

function PortField({
  port,
  value,
  onChange,
  bbKeys,
  enums,
  subtreeAuto,
}: {
  port: PortModel;
  value: string | undefined;
  onChange: (v: string | undefined) => void;
  bbKeys: string[];
  /** The spec's enums by type; a port of an enum type picks its literal from a list. */
  enums: Map<string, EnumModel>;
  subtreeAuto: boolean;
}) {
  const type = port.type ?? "";
  const enumModel = enumForType(port.type, enums);
  const problem = value && port.direction === "input" ? literalProblem(port.type, value, enums) : undefined;
  const listId = `bb-${port.name}`;
  // BT.CPP may write an enum default as its integer; show the name.
  const defaultLabel = port.default !== undefined && enumModel ? (findEnumValue(enumModel, port.default)?.name ?? port.default) : port.default;
  const placeholder =
    defaultLabel !== undefined ? `default: ${defaultLabel}` : subtreeAuto ? `auto: {${port.name}}` : port.direction === "input" ? "required" : "unused";
  const isRef = value !== undefined && isBlackboardRef(value);
  const enumValue = enumModel && value !== undefined && !isRef ? findEnumValue(enumModel, value) : undefined;

  let input;
  if (enumModel && port.direction !== "output" && !isRef) {
    input = <EnumSelect enumModel={enumModel} value={value} emptyLabel={placeholder} problem={problem} onChange={onChange} />;
  } else if (SCRIPT_PORTS.has(port.name) && !isRef) {
    input = (
      <textarea className="mono" rows={2} value={value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)} />
    );
  } else {
    input = (
      <>
        <input
          className={`mono${isRef ? " bb" : ""}${problem ? " invalid" : ""}`}
          list={listId}
          value={value ?? ""}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
        />
        <datalist id={listId}>
          {bbKeys.map((k) => (
            <option key={k} value={`{${k}}`} />
          ))}
        </datalist>
      </>
    );
  }

  return (
    <div className="field port-field">
      <span className="field-label">
        <span className="dir" title={DIR_TITLE[port.direction]}>
          {DIR_ARROW[port.direction]}
        </span>
        {port.name}
        {type && <span className="muted type">{type.replace(/^std::/, "")}</span>}
      </span>
      <div className="row">
        {input}
        <button
          type="button"
          className={`icon-button ${isRef ? "on" : ""}`}
          title={isRef ? "Use a literal value" : "Use a blackboard entry"}
          onClick={() => {
            if (isRef) onChange(value!.trim().slice(1, -1));
            else onChange(`{${value && /^[A-Za-z_]\w*$/.test(value) ? value : port.name}}`);
          }}
        >
          {"{}"}
        </button>
        {value !== undefined && (
          <button type="button" className="icon-button" title="Unset" onClick={() => onChange(undefined)}>
            ×
          </button>
        )}
      </div>
      {port.description && <span className="field-help">{port.description}</span>}
      {enumValue?.description && <span className="field-help">{enumValue.name}: {enumValue.description}</span>}
    </div>
  );
}

/** Picks a value of `enumModel`. A literal that isn't in the list stays selectable, flagged, rather than showing as unset. */
function EnumSelect({
  enumModel,
  value,
  emptyLabel,
  problem,
  onChange,
}: {
  enumModel: EnumModel;
  value: string | undefined;
  emptyLabel: string;
  /** What's wrong with `value`, from literalProblem(). */
  problem?: string;
  onChange: (v: string | undefined) => void;
}) {
  const unknown = value !== undefined && !enumModel.values.some((v) => v.name === value);
  const alias = unknown ? findEnumValue(enumModel, value)?.name : undefined;
  return (
    <select className={problem ? "invalid" : undefined} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
      <option value="">{emptyLabel}</option>
      {enumModel.values.map((v) => (
        <option key={v.name} value={v.name} title={v.description}>
          {v.name}
        </option>
      ))}
      {unknown && (
        <option value={value}>
          {value}
          {problem ? ` (${problem})` : alias ? ` (${alias})` : ""}
        </option>
      )}
    </select>
  );
}

/** An enum's values when the type is an enum (a blackboard reference stays free text), else a text field. */
/** A value of `type`: picked from a list for an enum (a blackboard reference stays free text), else typed. */
function TypedValueInput({
  type,
  enums,
  value,
  placeholder,
  emptyLabel,
  onChange,
}: {
  type: string | undefined;
  enums: Map<string, EnumModel>;
  value: string | undefined;
  placeholder: string;
  emptyLabel: string;
  onChange: (v: string | undefined) => void;
}) {
  const enumModel = enumForType(type, enums);
  const problem = value ? literalProblem(type, value, enums) : undefined;
  if (enumModel && !(value !== undefined && isBlackboardRef(value))) {
    return <EnumSelect enumModel={enumModel} value={value} emptyLabel={emptyLabel} problem={problem} onChange={onChange} />;
  }
  return (
    <input
      className={problem ? "mono invalid" : "mono"}
      title={problem && `"${value}" is ${problem}`}
      placeholder={placeholder}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value)}
    />
  );
}

function TreeInspector({ tree }: { tree: TreeDef }) {
  const files = useStore((s) => s.files);
  const trees = useStore((s) => s.trees);
  const file = files[tree.file];
  const models = useModels();
  const enums = useEnums();
  const usedBy = useMemo(() => treesUsing(trees, tree.id), [trees, tree.id]);
  const count = useMemo(() => {
    let c = 0;
    const visit = (n: BTNode) => {
      c++;
      n.children.forEach(visit);
    };
    if (tree.root) visit(tree.root);
    return c;
  }, [tree.root]);

  const setPorts = (fn: (ports: PortModel[]) => PortModel[], key?: string) => editTree(tree.id, (t) => ({ ...t, ports: fn(t.ports) }), key);

  return (
    <div className="inspector-body">
      <div className="inspector-title cat-subtree">
        <span className="bt-node-icon">▣</span>
        <div>
          <div className="inspector-type">{tree.id}</div>
          <div className="muted small-text">
            {tree.file} · {count} node{count === 1 ? "" : "s"}
          </div>
        </div>
      </div>
      <div className="row">
        <button onClick={() => useStore.setState({ dialog: { kind: "renameTree", treeId: tree.id } })}>Rename…</button>
        <label className="check">
          <input type="checkbox" checked={file?.mainTree === tree.id} onChange={(e) => setMainTree(tree.id, e.target.checked)} />
          <span>Main tree of its file</span>
        </label>
      </div>
      <label className="field">
        <span className="field-label">Description</span>
        <textarea
          rows={2}
          value={tree.description ?? ""}
          onChange={(e) => editTree(tree.id, (t) => ({ ...t, description: e.target.value || undefined }), `${tree.id}:desc`)}
        />
      </label>

      <h4 className="section-title">
        SubTree interface
        <span className="muted"> — ports callers can remap</span>
      </h4>
      {tree.ports.length === 0 && <p className="muted small-text">No ports. Without ports, callers remap freely or use auto-remap.</p>}
      {tree.ports.map((p, i) => (
        <div key={i} className="iface-port">
          <div className="row">
            <select
              value={p.direction}
              onChange={(e) => setPorts((ps) => ps.map((q, j) => (j === i ? { ...q, direction: e.target.value as PortDirection } : q)))}
              title="Direction"
            >
              <option value="input">in</option>
              <option value="output">out</option>
              <option value="inout">in/out</option>
            </select>
            <input
              className="mono"
              placeholder="name"
              value={p.name}
              onChange={(e) => setPorts((ps) => ps.map((q, j) => (j === i ? { ...q, name: e.target.value } : q)), `${tree.id}:port${i}:name`)}
            />
            <button className="icon-button" title="Remove port" onClick={() => setPorts((ps) => ps.filter((_, j) => j !== i))}>
              ×
            </button>
          </div>
          <div className="row">
            <input
              className="mono"
              placeholder="type"
              list="tree-port-enum-types"
              value={p.type ?? ""}
              onChange={(e) => setPorts((ps) => ps.map((q, j) => (j === i ? { ...q, type: e.target.value || undefined } : q)), `${tree.id}:port${i}:type`)}
            />
            <TypedValueInput
              type={p.type}
              enums={enums}
              placeholder="default"
              emptyLabel="no default"
              value={p.default}
              onChange={(v) => setPorts((ps) => ps.map((q, j) => (j === i ? { ...q, default: v } : q)), `${tree.id}:port${i}:def`)}
            />
          </div>
          <input
            placeholder="description"
            value={p.description ?? ""}
            onChange={(e) =>
              setPorts((ps) => ps.map((q, j) => (j === i ? { ...q, description: e.target.value || undefined } : q)), `${tree.id}:port${i}:desc`)
            }
          />
        </div>
      ))}
      <datalist id="tree-port-enum-types">
        {[...enums.keys()].map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className="row">
        <button onClick={() => setPorts((ps) => [...ps, { name: `port${ps.length + 1}`, direction: "input" }])}>+ Add port</button>
        {tree.root && (
          <button
            title="Declare every {key} used in this tree as an in/out port"
            onClick={() => {
              const types = blackboardKeyTypes(tree.root, models);
              setPorts((ps) => [
                ...ps,
                ...blackboardKeys(tree.root)
                  .filter((k) => !ps.some((p) => p.name === k))
                  .map((k) => ({ name: k, direction: "inout" as const, ...(types.has(k) ? { type: types.get(k) } : {}) })),
              ]);
            }}
          >
            + From blackboard keys
          </button>
        )}
      </div>

      <h4 className="section-title">Used by</h4>
      {usedBy.length === 0 ? (
        <p className="muted small-text">Not used as a SubTree.</p>
      ) : (
        <ul className="link-list">
          {usedBy.map((t) => (
            <li key={t.id}>
              <button className="link" onClick={() => openTree(t.id)}>
                {t.id}
              </button>
            </li>
          ))}
        </ul>
      )}
      {file?.readOnlyReason && <div className="notice error">Read-only: {file.readOnlyReason}</div>}
    </div>
  );
}
