// Data model shared by the backend (which owns the XML files) and the frontend (which edits them).
// The frontend never sees XML from disk: the backend parses project files into these types and
// writes them back out with serializeTreeFile() from ./xml_write.ts.

import type { Diagnostic, LoadedFile, NodeModel, TreeDef } from "@coalman321/arborist";

export interface TreeFile extends LoadedFile {
  /** Content hash when loaded; sent back on save to detect edits made outside the editor. */
  version: string;
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
  /** Models from the spec file only; builtins are added by the frontend (see projectModels). */
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

/** The git the desktop app ships with, for machines without their own (GET /api/about). */
export interface BundledGitInfo {
  version: string;
  /** Git's licence (GPLv2), in full. */
  license: string;
  /** Git's source at this version. */
  source: string;
  /** How this build of git was made, and the other open-source parts it includes. */
  build: string;
  /** Whether Arbor is using it, rather than the machine's own git. */
  inUse: boolean;
}

/** A library bundled into Arbor's builds; dist/licenses.json lists them (scripts/licenses.mjs). */
export interface LibraryLicense {
  name: string;
  version: string;
  /** SPDX identifier, as the package declares it. */
  license: string;
  homepage: string | null;
  /** The package's licence file(s), or null if it has none. */
  text: string | null;
}

/** GET /api/about: third-party software this copy of Arbor ships with. */
export interface AboutInfo {
  bundledGit: BundledGitInfo | null;
}

/** GET /api/git/snapshot: the project as it was at one revision. */
export interface RevSnapshot {
  rev: string;
  /** The commit `rev` resolved to; null for WORKTREE. */
  sha: string | null;
  /** Short description for the UI ("main · 1a2b3c4", "Working tree"). */
  label: string;
  snapshot: ProjectSnapshot;
}
