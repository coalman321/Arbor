// Looking up the model that describes a node: builtins, the project's node spec, and its trees.

import { BUILTIN_MODELS, SUBTREE_MODEL } from "./builtins.ts";
import { childBounds, type BTNode, type NodeModel, type TreeDef } from "./model.ts";

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
