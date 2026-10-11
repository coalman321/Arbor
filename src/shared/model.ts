// Data model shared by the backend (which owns the XML files) and the frontend (which edits them).
// The frontend never sees XML from disk: the backend parses project files into these types and
// writes them back out with serializeTreeFile() from ./xml_write.ts.

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
  /** C++ type as BT.CPP prints it (e.g. "std::string", "int", "Pose2D"). Informational only. */
  type?: string;
  /** Default value; a port with a default is optional in the editor's validation. */
  default?: string;
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

export interface TreeFile {
  path: string;
  /** main_tree_to_execute on <root>, if present. */
  mainTree?: string;
  /** <include path="..."/> elements, preserved on save. */
  includes: string[];
  /** IDs of the trees in this file, in file order. */
  treeIds: string[];
  /** Content hash when loaded; sent back on save to detect edits made outside the editor. */
  version: string;
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

export interface ProjectManifest {
  name: string;
  /** Project-relative path of the TreeNodesModel file. */
  nodes: string;
  /** Project-relative directory holding tree files (searched recursively for *.xml). */
  trees: string;
  live: { url: string };
}

export interface ProjectSnapshot {
  root: string;
  manifest: ProjectManifest;
  /** Models from the spec file only; builtins are added by the frontend (see ./builtins.ts). */
  specModels: NodeModel[];
  /** Raw sha of the spec file contents, so the client can tell when it was regenerated. */
  specVersion: string;
  files: TreeFile[];
  trees: TreeDef[];
  /** Problems found while loading (unparsable XML, duplicate IDs, missing spec). */
  diagnostics: Diagnostic[];
}

/** Body of PUT /api/files: everything needed to rewrite one tree file. */
export interface SaveFileRequest {
  path: string;
  mainTree?: string;
  includes: string[];
  trees: TreeDef[];
  /** Overwrite even if the file changed on disk since `baseVersion`. */
  force?: boolean;
  baseVersion?: string;
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

export interface RecentProject {
  path: string;
  name: string;
  /** False if the directory is gone or no longer a project. */
  exists: boolean;
}

/** GET /api/workspace: what the "open project" UI needs. */
export interface WorkspaceInfo {
  /** Root of the open project, or null when none is open. */
  current: string | null;
  recent: RecentProject[];
  /** Where the folder browser starts. */
  home: string;
  /** If set, only paths under this directory can be browsed or opened. */
  limit: string | null;
}

/** GET /api/fs: one directory, for the folder/file browser. */
export interface BrowseResult {
  path: string;
  parent: string | null;
  isProject: boolean;
  entries: { name: string; kind: "dir" | "xml"; isProject?: boolean }[];
}

/** The pseudo-revision for the project files as they are on disk now (saved edits only). */
export const WORKTREE = "WORKTREE";

export interface GitCommit {
  sha: string;
  short: string;
  author: string;
  /** ISO 8601 author date. */
  date: string;
  subject: string;
  /** Parent commits, as rewritten for the project's paths: what the history graph connects. */
  parents: string[];
  /** Branches and tags pointing here ("HEAD -> main", "tag: v1.0"), as git log's %D prints them. */
  refs: string[];
}

/** GET /api/git/revs: what can be compared. */
export type GitInfo =
  | { available: false; reason: string }
  | {
      available: true;
      /** Current branch, or null on a detached HEAD. */
      branch: string | null;
      /** The checked-out commit, or null in a repository without commits. */
      head: string | null;
      branches: string[];
      tags: string[];
      /** Commits on HEAD that touched the project's trees or node spec, newest first (topological). */
      commits: GitCommit[];
      /** More commits exist beyond `commits` (ask again with a higher limit). */
      more: boolean;
      /** The trees or spec on disk differ from HEAD. */
      dirty: boolean;
    };

/** GET /api/git/snapshot: the project as it was at one revision. */
export interface RevSnapshot {
  rev: string;
  /** The commit `rev` resolved to; null for WORKTREE. */
  sha: string | null;
  /** Short description for the UI ("main · 1a2b3c4", "Working tree"). */
  label: string;
  snapshot: ProjectSnapshot;
}
