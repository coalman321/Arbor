// Static checks of trees against the node models, mirroring what BT.CPP would reject at load time
// (unknown nodes, wrong child counts, missing SubTrees, recursion) plus softer lint warnings.

import { BUILTIN_MODELS, SUBTREE_MODEL } from "./builtins.ts";
import {
  childBounds,
  isBlackboardRef,
  RESERVED_ATTRS,
  walk,
  type BTNode,
  type Diagnostic,
  type NodeModel,
  type TreeDef,
} from "./model.ts";

/**
 * Every model available to a project, by ID: builtins, overridden by the spec file, plus one
 * SubTree model per tree (keyed "SubTree:<id>") describing that tree's ports.
 */
export function projectModels(specModels: NodeModel[], trees: Iterable<TreeDef>): Map<string, NodeModel> {
  const models = new Map<string, NodeModel>();
  for (const m of BUILTIN_MODELS) models.set(m.id, m);
  models.set(SUBTREE_MODEL.id, SUBTREE_MODEL);
  for (const m of specModels) {
    if (m.category === "SubTree") continue; // subtree interfaces come from the trees themselves
    models.set(m.id, m);
  }
  for (const t of trees) {
    models.set(subtreeModelKey(t.id), {
      id: t.id,
      category: "SubTree",
      ports: t.ports,
      description: t.description,
      source: "tree",
    });
  }
  return models;
}

export function subtreeModelKey(treeId: string): string {
  return `SubTree:${treeId}`;
}

/** The model that describes a node: its registered type, or for a SubTree, the referenced tree. */
export function modelFor(node: BTNode, models: Map<string, NodeModel>): NodeModel | undefined {
  if (node.type === "SubTree") return models.get(subtreeModelKey(node.attrs.ID ?? "")) ?? models.get("SubTree");
  return models.get(node.type);
}

const EXACT_CHILDREN: Record<string, [number, number]> = {
  IfThenElse: [2, 3],
  WhileDoElse: [2, 3],
  TryCatch: [2, Infinity],
  Switch2: [3, 3],
  Switch3: [4, 4],
  Switch4: [5, 5],
  Switch5: [6, 6],
  Switch6: [7, 7],
};

export function allowedChildren(node: BTNode, models: Map<string, NodeModel>): [number, number] {
  return EXACT_CHILDREN[node.type] ?? childBounds(modelFor(node, models)?.category);
}

export function validateTree(tree: TreeDef, models: Map<string, NodeModel>, trees: Map<string, TreeDef>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const at = (n: BTNode | null, severity: Diagnostic["severity"], message: string) =>
    out.push({ severity, message, file: tree.file, treeId: tree.id, ...(n ? { nodeUid: n.uid } : {}) });

  if (!tree.root) {
    at(null, "warning", `Tree "${tree.id}" is empty`);
    return out;
  }

  walk(tree.root, (node) => {
    const model = modelFor(node, models);
    const label = node.attrs.name ? `${node.type} "${node.attrs.name}"` : node.type;

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

export function validateProject(trees: Map<string, TreeDef>, models: Map<string, NodeModel>, mainTrees: (string | undefined)[]): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const t of trees.values()) out.push(...validateTree(t, models, trees));
  for (const m of mainTrees) {
    if (m && !trees.has(m)) out.push({ severity: "warning", message: `main_tree_to_execute "${m}" is not defined` });
  }
  return out;
}
