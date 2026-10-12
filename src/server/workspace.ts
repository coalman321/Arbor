// Which project the editor has open, plus what the UI needs to pick another one: recent projects,
// a directory browser (the browser can't see local paths itself) and importing tree files.

import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import type { BrowseResult, RecentProject, WorkspaceInfo } from "../shared/model.ts";
import { initProject, MANIFEST_FILE, Project, ProjectError } from "./project.ts";
import { parseTreeFile, XmlError } from "@coalman321/arborist";

const RECENT_LIMIT = 10;

/** A directory looks like a project if it has a manifest, or a node spec next to a trees/ dir. */
export function isProjectDir(dir: string): boolean {
  return existsSync(join(dir, MANIFEST_FILE)) || (existsSync(join(dir, "nodes.xml")) && existsSync(join(dir, "trees")));
}

/** Default place for recent.json, shared by the `arbor` command and the desktop app. */
export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "bt-editor");
}

export class Workspace {
  project: Project | null = null;
  private listeners: ((p: Project | null) => void)[] = [];

  /**
   * @param limit if set, every path the UI can browse, open, create or import from must be under it
   *   (used when the server is reachable from other machines).
   * @param configDir where recent.json lives.
   */
  constructor(
    readonly limit: string | null,
    private readonly configDir: string,
  ) {}

  onChange(fn: (p: Project | null) => void) {
    this.listeners.push(fn);
  }

  /** Resolves a path from the UI, refusing anything outside `limit`. */
  checkPath(path: string): string {
    if (!path || !isAbsolute(path)) throw new ProjectError(`Expected an absolute path, got "${path}"`);
    const abs = resolve(path);
    if (this.limit && abs !== this.limit && !abs.startsWith(this.limit + sep)) {
      throw new ProjectError(`Only paths under ${this.limit} can be used`, 403);
    }
    return abs;
  }

  requireProject(): Project {
    if (!this.project) throw new ProjectError("No project is open", 409);
    return this.project;
  }

  async open(path: string): Promise<Project> {
    const dir = this.checkPath(path);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ProjectError(`${dir} is not a directory`, 404);
    if (!isProjectDir(dir)) {
      throw new ProjectError(`${dir} is not a project (no ${MANIFEST_FILE}, or nodes.xml and trees/). Create one there instead.`);
    }
    const project = new Project(dir);
    await project.load(); // fail on a broken manifest before switching
    this.project = project;
    await this.remember(project);
    for (const fn of this.listeners) fn(project);
    return project;
  }

  async create(path: string): Promise<Project> {
    const dir = this.checkPath(path);
    if (isProjectDir(dir)) throw new ProjectError(`${dir} already contains a project; open it instead`);
    if (existsSync(dir) && !statSync(dir).isDirectory()) throw new ProjectError(`${dir} is a file`);
    await initProject(dir);
    return this.open(dir);
  }

  private get recentFile() {
    return join(this.configDir, "recent.json");
  }

  async recent(): Promise<RecentProject[]> {
    let paths: string[] = [];
    try {
      paths = JSON.parse(await readFile(this.recentFile, "utf8"));
    } catch {
      // none yet, or unreadable; start over
    }
    const out: RecentProject[] = [];
    for (const p of Array.isArray(paths) ? paths : []) {
      if (typeof p !== "string") continue;
      if (this.limit && !p.startsWith(this.limit + sep) && p !== this.limit) continue;
      const exists = existsSync(p) && isProjectDir(p);
      let name = basename(p);
      if (exists) name = (await new Project(p).manifest().catch(() => null))?.name ?? name;
      out.push({ path: p, name, exists });
    }
    return out;
  }

  private async remember(project: Project) {
    const paths = (await this.recent()).map((r) => r.path).filter((p) => p !== project.root);
    try {
      await mkdir(this.configDir, { recursive: true });
      await writeFile(this.recentFile, JSON.stringify([project.root, ...paths].slice(0, RECENT_LIMIT), null, 2) + "\n");
    } catch (e) {
      console.warn(`Couldn't save recent projects: ${(e as Error).message}`);
    }
  }

  async forget(path: string) {
    const paths = (await this.recent()).map((r) => r.path).filter((p) => p !== path);
    await mkdir(this.configDir, { recursive: true });
    await writeFile(this.recentFile, JSON.stringify(paths, null, 2) + "\n");
  }

  async info(): Promise<WorkspaceInfo> {
    return {
      current: this.project?.root ?? null,
      recent: await this.recent(),
      home: this.limit ?? homedir(),
      limit: this.limit,
    };
  }

  /** Lists a directory: subdirectories (marking projects) and .xml files. */
  async browse(path: string): Promise<BrowseResult> {
    const dir = this.checkPath(path);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ProjectError(`${dir} is not a directory`, 404);
    const entries: BrowseResult["entries"] = [];
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) entries.push({ name: e.name, kind: "dir", isProject: isProjectDir(full) });
      else if (e.isFile() && extname(e.name) === ".xml") entries.push({ name: e.name, kind: "xml" });
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
    const parent = dirname(dir);
    const parentAllowed = parent !== dir && (!this.limit || dir !== this.limit);
    return { path: dir, parent: parentAllowed ? parent : null, isProject: isProjectDir(dir), entries };
  }

  /**
   * Copies a BT.CPP tree file into the open project's trees directory. Refuses files that don't
   * parse or that define a tree ID the project already has, since BT.CPP couldn't load both.
   */
  async importTree(source: string): Promise<{ path: string; treeIds: string[] }> {
    const project = this.requireProject();
    const src = this.checkPath(source);
    if (extname(src) !== ".xml" || !existsSync(src)) throw new ProjectError(`${src} is not an .xml file`, 404);
    let parsed;
    try {
      parsed = parseTreeFile(await readFile(src, "utf8"), basename(src));
    } catch (e) {
      throw new ProjectError(e instanceof XmlError ? `${basename(src)}: ${e.message}` : (e as Error).message);
    }
    if (!parsed.trees.length) throw new ProjectError(`${basename(src)} has no <BehaviorTree> in it`);
    const snap = await project.load();
    const existing = new Set(snap.trees.map((t) => t.id));
    const clash = parsed.trees.map((t) => t.id).filter((id) => existing.has(id));
    if (clash.length) throw new ProjectError(`This project already has a tree named ${clash.map((c) => `"${c}"`).join(", ")}`);

    const treesDir = project.resolvePath(snap.manifest.trees);
    if (src.startsWith(treesDir + sep)) throw new ProjectError(`${basename(src)} is already part of this project`);
    await mkdir(treesDir, { recursive: true });
    const stem = basename(src, ".xml");
    let dest = join(treesDir, `${stem}.xml`);
    for (let i = 2; existsSync(dest); i++) dest = join(treesDir, `${stem}_${i}.xml`);
    await copyFile(src, dest);
    return { path: `${snap.manifest.trees}/${basename(dest)}`, treeIds: parsed.trees.map((t) => t.id) };
  }
}
