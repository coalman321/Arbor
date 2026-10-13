// The tree data model: BehaviorTree.CPP v4 trees and node models as parsed from XML (./xml_read.ts).
// Hosts never deal with XML directly: loadTrees() (./load.ts) turns files into these types.

export type NodeCategory = "Action" | "Condition" | "Control" | "Decorator" | "SubTree";

/** Display order: project-specific leaves first, since that's what users reach for most. */
export const NODE_CATEGORIES: readonly NodeCategory[] = [
  "Action",
  "Condition",
  "Control",
  "Decorator",
  "SubTree",
];

export type PortDirection = "input" | "output" | "inout";

export interface PortModel {
  name: string;
  direction: PortDirection;
  /**
   * C++ type as BT.CPP prints it (e.g. "std::string", "int", "Pose2D"). Informational, except that
   * a type named by an EnumModel in the spec limits the port's literal values to that enum's.
   */
  type?: string;
  /** Default value; a port with a default is optional in the editor's validation. */
  default?: string;
  description?: string;
}

export interface EnumValue {
  name: string;
  /** Integer value in C++, if the spec gives one. BT.CPP accepts it in place of the name. */
  value?: number;
  description?: string;
}

/**
 * An enumeration from the node spec's <Enums> section. A port uses it when the port's `type` is
 * exactly `type`; its literal values should then be one of `values` (or a blackboard entry).
 */
export interface EnumModel {
  type: string;
  values: EnumValue[];
  description?: string;
}

export type ModelSource = "builtin" | "spec" | "tree";

/** A node type that can be placed in a tree: a TreeNodesModel entry, a BT.CPP builtin, or a tree. */
export interface NodeModel {
  id: string;
  category: NodeCategory;
  ports: PortModel[];
  description?: string;
  /** <MetaFields> from the TreeNodesModel, shown in the inspector. */
  metadata?: Record<string, string>;
  source: ModelSource;
}

/**
 * One node of a tree as written in XML. `type` is the registration ID, i.e. the element name in
 * BT.CPP v4's compact form (<Sequence>, <MoveBase>, <SubTree>); `attrs` holds every XML attribute in
 * file order, ports and special ones (name, ID, _autoremap, _skipIf, ...) alike.
 */
export interface BTNode {
  /** Editor-only identity; never written to XML. Unique within its tree. */
  uid: string;
  type: string;
  attrs: Record<string, string>;
  children: BTNode[];
}

export interface TreeDef {
  /** <BehaviorTree ID="...">; unique across the project, since BT.CPP registers trees by ID. */
  id: string;
  /** Project-relative path of the file that holds this tree. */
  file: string;
  description?: string;
  /** The tree's interface when used as a SubTree, kept in the file's <TreeNodesModel>. */
  ports: PortModel[];
  /** Attributes of <BehaviorTree> other than ID and _description, preserved on save. */
  attrs: Record<string, string>;
  root: BTNode | null;
}

/** One XML file of trees, as loadTrees() read it. */
export interface LoadedFile {
  path: string;
  /** main_tree_to_execute on <root>, if present. */
  mainTree?: string;
  /** <include path="..."/> elements, preserved on save. */
  includes: string[];
  /** IDs of the trees in this file, in file order. */
  treeIds: string[];
  /** Set when the file can't be safely written back (parse error, duplicate tree ID, ...). */
  readOnlyReason?: string;
}

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  message: string;
  file?: string;
  treeId?: string;
  nodeUid?: string;
}

/** Attributes BT.CPP treats specially on every node; shown in the inspector's "Advanced" section. */
export const PRE_POST_CONDITIONS: readonly { name: string; help: string }[] = [
  { name: "_skipIf", help: "Skip the node (status SKIPPED) if this script is true" },
  { name: "_failureIf", help: "Return FAILURE without ticking if this script is true" },
  { name: "_successIf", help: "Return SUCCESS without ticking if this script is true" },
  { name: "_while", help: "Tick only while this script is true; halt and skip otherwise" },
  { name: "_onSuccess", help: "Script executed when the node returns SUCCESS" },
  { name: "_onFailure", help: "Script executed when the node returns FAILURE" },
  { name: "_onHalted", help: "Script executed when the node is halted" },
  { name: "_post", help: "Script executed when the node returns SUCCESS or FAILURE" },
];

/** Attributes that are not ports, so validation doesn't flag them as unknown. */
export const RESERVED_ATTRS = new Set<string>([
  "name",
  "ID",
  "_autoremap",
  "_description",
  "_uid",
  "_fullpath",
  ...PRE_POST_CONDITIONS.map((c) => c.name),
]);

export function isBlackboardRef(value: string): boolean {
  return /^\{[^{}]+\}$/.test(value.trim());
}

/** The value a port literal names, by name or by integer (BT.CPP's getInput<Enum>() accepts both). */
export function findEnumValue(e: EnumModel, literal: string): EnumValue | undefined {
  const text = literal.trim();
  if (/^-?\d+$/.test(text)) return e.values.find((v) => v.value === Number(text));
  return e.values.find((v) => v.name === text);
}

/**
 * Whether BT.CPP would read `literal` as a value of `e`. Any integer passes when the spec gives no
 * integer values, since there is nothing to check it against.
 */
export function isEnumLiteral(e: EnumModel, literal: string): boolean {
  if (findEnumValue(e, literal)) return true;
  return /^-?\d+$/.test(literal.trim()) && e.values.every((v) => v.value === undefined);
}

/** Number of children a node of this category may have: [min, max]. */
export function childBounds(category: NodeCategory | undefined): [number, number] {
  switch (category) {
    case "Control":
      return [1, Infinity];
    case "Decorator":
      return [1, 1];
    case "Action":
    case "Condition":
    case "SubTree":
      return [0, 0];
    default:
      return [0, Infinity];
  }
}

export function walk(node: BTNode | null, fn: (n: BTNode, parent: BTNode | null) => void, parent: BTNode | null = null) {
  if (!node) return;
  fn(node, parent);
  for (const c of node.children) walk(c, fn, node);
}

export function findNode(root: BTNode | null, uid: string): BTNode | null {
  let found: BTNode | null = null;
  walk(root, (n) => {
    if (n.uid === uid) found = n;
  });
  return found;
}

export function findParent(root: BTNode | null, uid: string): BTNode | null {
  let found: BTNode | null = null;
  walk(root, (n, p) => {
    if (n.uid === uid) found = p;
  });
  return found;
}

/** Display label: the node's name if set and different from its type, else the type. */
export function nodeLabel(n: BTNode): string {
  if (n.type === "SubTree") return n.attrs.name || n.attrs.ID || "SubTree";
  return n.attrs.name || n.type;
}
