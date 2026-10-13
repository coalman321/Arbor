// Static checks of trees against the node models, mirroring what BT.CPP would reject at load time
// (unknown nodes, wrong child counts, missing SubTrees, recursion) plus softer lint warnings.

import {
  allowedChildren,
  isBlackboardRef,
  literalProblem,
  modelFor,
  RESERVED_ATTRS,
  walk,
  type BTNode,
  type Diagnostic,
  type EnumModel,
  type NodeModel,
  type TreeDef,
} from "@coalman321/arborist";

export function validateTree(
  tree: TreeDef,
  models: Map<string, NodeModel>,
  trees: Map<string, TreeDef>,
  enums: Map<string, EnumModel> = new Map(),
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const at = (n: BTNode | null, severity: Diagnostic["severity"], message: string) =>
    out.push({ severity, message, file: tree.file, treeId: tree.id, ...(n ? { nodeUid: n.uid } : {}) });

  for (const p of tree.ports) {
    const problem = p.default ? literalProblem(p.type, p.default, enums) : undefined;
    if (problem) at(null, "warning", `Tree "${tree.id}": default "${p.default}" of port "${p.name}" is ${problem}`);
  }

  if (!tree.root) {
    at(null, "warning", `Tree "${tree.id}" is empty`);
    return out;
  }

  walk(tree.root, (node) => {
    const model = modelFor(node, models);
    const label =
      node.type === "SubTree" ? `SubTree ${node.attrs.ID ?? ""}`.trim() : node.attrs.name ? `${node.type} "${node.attrs.name}"` : node.type;

    if (node.type === "SubTree") {
      const target = node.attrs.ID;
      if (!target) at(node, "error", "SubTree has no ID");
      else if (!trees.has(target)) at(node, "error", `SubTree "${target}" is not defined in this project`);
      else if (reaches(target, tree.id, trees)) at(node, "error", `SubTree "${target}" recursively includes "${tree.id}"`);
    } else if (!model) {
      at(node, "error", `Unknown node type "${node.type}"; add it to the node spec`);
      return;
    }

    const [min, max] = allowedChildren(node, models);
    const n = node.children.length;
    if (n < min || n > max) {
      const want = min === max ? `${min}` : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
      at(node, "error", `${label} must have ${want} child${want === "1" ? "" : "ren"}, has ${n}`);
    }

    if (!model) return;
    const ports = new Map(model.ports.map((p) => [p.name, p]));
    for (const p of model.ports) {
      const value = node.attrs[p.name];
      const remapped = node.type === "SubTree" && node.attrs._autoremap === "true";
      if (value === undefined && p.default === undefined && p.direction !== "output" && !remapped) {
        at(node, "warning", `${label}: input port "${p.name}" is not set`);
      }
      if (value !== undefined && p.direction !== "input" && value !== "" && !isBlackboardRef(value) && node.type !== "SubTree") {
        at(node, "warning", `${label}: output port "${p.name}" should name a blackboard entry, e.g. {${p.name}}`);
      }
      const problem = value && p.direction === "input" ? literalProblem(p.type, value, enums) : undefined;
      if (problem) at(node, "warning", `${label}: "${value}" is ${problem} (port "${p.name}")`);
    }
    for (const attr of Object.keys(node.attrs)) {
      if (RESERVED_ATTRS.has(attr) || ports.has(attr)) continue;
      // A SubTree with no declared interface accepts any remapping.
      if (node.type === "SubTree" && model.ports.length === 0) continue;
      at(node, "warning", `${label}: "${attr}" is not a port of ${model.id}`);
    }
  });
  return out;
}

/** True if tree `from` (transitively) instantiates tree `target`. */
function reaches(from: string, target: string, trees: Map<string, TreeDef>, seen = new Set<string>()): boolean {
  if (from === target) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  let found = false;
  walk(trees.get(from)?.root ?? null, (n) => {
    if (!found && n.type === "SubTree" && n.attrs.ID && reaches(n.attrs.ID, target, trees, seen)) found = true;
  });
  return found;
}

export function validateProject(
  trees: Map<string, TreeDef>,
  models: Map<string, NodeModel>,
  mainTrees: (string | undefined)[],
  enums: Map<string, EnumModel> = new Map(),
): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const t of trees.values()) out.push(...validateTree(t, models, trees, enums));
  for (const m of mainTrees) {
    if (m && !trees.has(m)) out.push({ severity: "warning", message: `main_tree_to_execute "${m}" is not defined` });
  }
  return out;
}
