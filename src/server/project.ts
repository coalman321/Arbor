// Loads and saves a project directory:
//
//   <project>/
//     bt_project.json   optional manifest (name, spec path, trees dir, robot URL)
//     nodes.xml         node spec: a TreeNodesModel, e.g. written by BT::writeTreeNodesModelXML()
//     trees/**/*.xml    one or more BehaviorTree.CPP v4 tree files

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  Diagnostic,
  NodeModel,
  ProjectManifest,
  ProjectSnapshot,
  SaveFileRequest,
  TreeDef,
  TreeFile,
} from "../shared/model.ts";
import { serializeSpecFile, serializeTreeFile } from "../shared/xml_write.ts";
import { GitRepo } from "./git.ts";
import { parseSpecFile, parseTreeFile } from "./xml_read.ts";

export const MANIFEST_FILE = "bt_project.json";
export const DEFAULT_LIVE_URL = "ws://localhost:1670";

export class ProjectError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export function sha(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 12);
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

/**
 * Where a project's files are read from: the directory on disk, or a git revision (see git.ts).
 * Paths are project-relative with "/" separators.
 */
export interface ProjectSource {
  /** File contents, or undefined if there is no such file. */
  read(rel: string): Promise<string | undefined>;
  /** Every .xml file under directory `rel`, recursively, sorted. */
  listXml(rel: string): Promise<string[]>;
}

export class Project {
  readonly root: string;
  /** Content hash of every file as last read or written by us, keyed by project-relative path. */
  private versions = new Map<string, string>();
  private gitRepo?: Promise<GitRepo | null>;
  readonly disk: ProjectSource = {
    read: async (rel) => {
      const abs = this.resolvePath(rel);
      return existsSync(abs) ? readFile(abs, "utf8") : undefined;
    },
    listXml: async (rel) => (await this.listTreeFiles(this.resolvePath(rel))).map((abs) => toPosix(relative(this.root, abs))),
  };

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** The git repository holding this project, or null if it isn't in one (or git isn't installed). */
  git(): Promise<GitRepo | null> {
    this.gitRepo ??= GitRepo.open(this);
    return this.gitRepo;
  }

  async manifest(source: ProjectSource = this.disk): Promise<ProjectManifest> {
    const defaults: ProjectManifest = {
      name: basename(this.root),
      nodes: "nodes.xml",
      trees: "trees",
      live: { url: DEFAULT_LIVE_URL },
    };
    const text = await source.read(MANIFEST_FILE);
    if (text === undefined) return defaults;
    let raw: Partial<ProjectManifest>;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      throw new ProjectError(`${MANIFEST_FILE}: ${(e as Error).message}`);
    }
    return {
      name: raw.name ?? defaults.name,
      nodes: raw.nodes ?? defaults.nodes,
      trees: raw.trees ?? defaults.trees,
      live: { url: raw.live?.url ?? defaults.live.url },
    };
  }

  /** Resolves a project-relative path, refusing anything that escapes the project directory. */
  resolvePath(rel: string): string {
    if (isAbsolute(rel)) throw new ProjectError(`Path must be project-relative: ${rel}`);
    const abs = resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new ProjectError(`Path escapes the project: ${rel}`);
    return abs;
  }

  /** Validates that `rel` names an .xml file inside the trees directory. */
  async treeFilePath(rel: string): Promise<string> {
    const manifest = await this.manifest();
    const abs = this.resolvePath(rel);
    const treesDir = this.resolvePath(manifest.trees);
    if (!abs.startsWith(treesDir + sep) || !abs.endsWith(".xml")) {
      throw new ProjectError(`Tree files must be .xml files under ${manifest.trees}/: ${rel}`);
    }
    return abs;
  }

  private async listTreeFiles(dir: string): Promise<string[]> {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...(await this.listTreeFiles(p)));
      else if (entry.isFile() && entry.name.endsWith(".xml")) out.push(p);
    }
    return out.sort();
  }

  /**
   * Reads the whole project. From any source other than the disk (an old git revision), the result
   * is for viewing only: the versions used to detect external edits are left alone.
   */
  async load(source: ProjectSource = this.disk): Promise<ProjectSnapshot> {
    const track = source === this.disk;
    const manifest = await this.manifest(source);
    const diagnostics: Diagnostic[] = [];

    let specModels: NodeModel[] = [];
    let specVersion = "";
    const xml = await source.read(manifest.nodes);
    if (xml !== undefined) {
      specVersion = sha(xml);
      if (track) this.versions.set(manifest.nodes, specVersion);
      try {
        specModels = parseSpecFile(xml);
      } catch (e) {
        diagnostics.push({ severity: "error", message: (e as Error).message, file: manifest.nodes });
      }
    } else {
      diagnostics.push({
        severity: "warning",
        message: `Node spec ${manifest.nodes} not found; only builtin nodes are available`,
        file: manifest.nodes,
      });
    }

    const files: TreeFile[] = [];
    const trees: TreeDef[] = [];
    const treeOwner = new Map<string, string>();
    const extraModels = new Map<string, NodeModel>();
    for (const rel of await source.listXml(manifest.trees)) {
      const xml = await source.read(rel);
      if (xml === undefined) continue;
      const version = sha(xml);
      if (track) this.versions.set(rel, version);
      const file: TreeFile = { path: rel, includes: [], treeIds: [], version };
      files.push(file);
      let parsed;
      try {
        parsed = parseTreeFile(xml, rel);
      } catch (e) {
        file.readOnlyReason = (e as Error).message;
        diagnostics.push({ severity: "error", message: (e as Error).message, file: rel });
        continue;
      }
      for (const w of parsed.warnings) diagnostics.push({ severity: "warning", message: w, file: rel });
      file.mainTree = parsed.mainTree;
      file.includes = parsed.includes;
      for (const t of parsed.trees) {
        const owner = treeOwner.get(t.id);
        if (owner) {
          file.readOnlyReason = `Tree ID "${t.id}" is already defined in ${owner}`;
          diagnostics.push({ severity: "error", message: file.readOnlyReason, file: rel, treeId: t.id });
          continue;
        }
        treeOwner.set(t.id, rel);
        file.treeIds.push(t.id);
        trees.push(t);
      }
      // Groot2 copies node models into each tree file; use them as a fallback for the spec.
      for (const m of parsed.nodeModels) if (!extraModels.has(m.id)) extraModels.set(m.id, m);
      // A file may also describe the ports of a tree defined in another file.
      for (const m of parsed.foreignSubtreeModels) {
        const t = trees.find((x) => x.id === m.id);
        if (t && t.ports.length === 0) t.ports = m.ports;
      }
    }

    const specIds = new Set(specModels.map((m) => m.id));
    const fallback = [...extraModels.values()].filter((m) => !specIds.has(m.id));
    if (fallback.length) {
      diagnostics.push({
        severity: "info",
        message: `${fallback.length} node type(s) are only declared in tree files (${fallback
          .slice(0, 5)
          .map((m) => m.id)
          .join(", ")}${fallback.length > 5 ? ", ..." : ""}); add them to ${manifest.nodes}`,
      });
    }

    return {
      root: this.root,
      manifest,
      specModels: [...specModels, ...fallback],
      specVersion,
      files,
      trees,
      diagnostics,
    };
  }

  /** Last content hash we read or wrote for this path, to tell our own writes from external ones. */
  knownVersion(rel: string): string | undefined {
    return this.versions.get(rel);
  }

  async currentVersion(rel: string): Promise<string | undefined> {
    const abs = this.resolvePath(rel);
    if (!existsSync(abs)) return undefined;
    return sha(await readFile(abs, "utf8"));
  }

  private async atomicWrite(rel: string, abs: string, content: string) {
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, abs);
    this.versions.set(rel, sha(content));
  }

  async saveTreeFile(req: SaveFileRequest): Promise<{ version: string }> {
    const abs = await this.treeFilePath(req.path);
    const onDisk = await this.currentVersion(req.path);
    if (!req.force && req.baseVersion !== undefined && onDisk !== undefined && onDisk !== req.baseVersion) {
      throw new ProjectError(`${req.path} changed on disk since it was loaded`, 409);
    }
    for (const t of req.trees) {
      if (!t.id || /[\s"<>&]/.test(t.id)) throw new ProjectError(`Invalid tree ID "${t.id}"`);
    }
    const content = serializeTreeFile({ mainTree: req.mainTree, includes: req.includes, trees: req.trees });
    // Groot2-style node models in the file are kept as-is: re-read and append them.
    let preserved = "";
    if (onDisk !== undefined) {
      try {
        const old = parseTreeFile(await readFile(abs, "utf8"), req.path);
        if (old.nodeModels.length) preserved = serializeSpecFile(old.nodeModels);
      } catch {
        // Unparsable before; nothing to preserve.
      }
    }
    const final = preserved ? mergeTreeNodesModel(content, preserved) : content;
    await this.atomicWrite(req.path, abs, final);
    return { version: sha(final) };
  }

  async deleteTreeFile(rel: string) {
    const abs = await this.treeFilePath(rel);
    if (!existsSync(abs)) throw new ProjectError(`${rel} does not exist`, 404);
    await rm(abs);
    this.versions.delete(rel);
  }

  async saveSpec(models: NodeModel[]): Promise<{ version: string }> {
    const manifest = await this.manifest();
    const content = serializeSpecFile(models.filter((m) => m.source === "spec"));
    await this.atomicWrite(manifest.nodes, this.resolvePath(manifest.nodes), content);
    return { version: sha(content) };
  }
}

/** Moves the <TreeNodesModel> children of `spec` into the TreeNodesModel of a serialized tree file. */
function mergeTreeNodesModel(treeXml: string, spec: string): string {
  const body = spec.split("\n").filter((l) => l.startsWith("    "));
  if (!body.length) return treeXml;
  if (treeXml.includes("  </TreeNodesModel>")) return treeXml.replace("  </TreeNodesModel>", `${body.join("\n")}\n  </TreeNodesModel>`);
  return treeXml.replace("</root>", `  <TreeNodesModel>\n${body.join("\n")}\n  </TreeNodesModel>\n</root>`);
}

/** Creates a new project with an empty spec and one tree. */
export async function initProject(root: string) {
  const abs = resolve(root);
  if (existsSync(join(abs, MANIFEST_FILE))) throw new ProjectError(`${abs} already has a ${MANIFEST_FILE}`);
  await mkdir(join(abs, "trees"), { recursive: true });
  const manifest: ProjectManifest = { name: basename(abs), nodes: "nodes.xml", trees: "trees", live: { url: DEFAULT_LIVE_URL } };
  await writeFile(join(abs, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
  if (!existsSync(join(abs, "nodes.xml"))) await writeFile(join(abs, "nodes.xml"), serializeSpecFile([]));
  const main = join(abs, "trees", "main.xml");
  if (!existsSync(main)) {
    await writeFile(
      main,
      serializeTreeFile({
        mainTree: "MainTree",
        includes: [],
        trees: [{ id: "MainTree", file: "trees/main.xml", ports: [], attrs: {}, root: null }],
      }),
    );
  }
}
