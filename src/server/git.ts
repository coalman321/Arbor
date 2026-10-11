// Read-only access to the git history of a project, for comparing its trees between revisions.
// Every call goes through execFile with an argument list (no shell), and revisions from the client
// are resolved to a commit id before they are used anywhere else.

import { execFile } from "node:child_process";
import { posix } from "node:path";
import { findGit, type GitBinary } from "./git_binary.ts";
import { WORKTREE, type GitCommit, type GitInfo, type ProjectSnapshot, type RevSnapshot } from "../shared/model.ts";
import { ProjectError, type Project, type ProjectSource } from "./project.ts";

const DEFAULT_COMMITS = 200;
const MAX_COMMITS = 5000;
const CACHE_SIZE = 16;

function git(bin: GitBinary, cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin.path, args, { cwd, env: bin.env, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

export class GitRepo {
  /** Snapshots by commit id; a commit never changes, so these never go stale. */
  private cache = new Map<string, ProjectSnapshot>();

  private constructor(
    private readonly project: Project,
    private readonly bin: GitBinary,
  ) {}

  /** The repository holding `project`, or why there isn't one. */
  static async open(project: Project): Promise<GitRepo | string> {
    const bin = await findGit();
    if (!bin) return "Comparing needs git, which isn't installed (or isn't on the PATH)";
    try {
      const inside = await git(bin, project.root, ["rev-parse", "--is-inside-work-tree"]);
      if (inside.trim() === "true") return new GitRepo(project, bin);
    } catch {
      // not a repository
    }
    return "This project is not in a git repository";
  }

  private run(args: string[]) {
    return git(this.bin, this.project.root, args);
  }

  /** Resolves a branch, tag, or commit expression to a commit id. */
  async resolve(rev: string): Promise<string> {
    // Refuse anything git could read as an option.
    if (!rev || rev.startsWith("-") || /\s/.test(rev)) throw new ProjectError(`Not a revision: ${rev}`);
    try {
      return (await this.run(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`])).trim();
    } catch {
      throw new ProjectError(`Unknown revision "${rev}"`, 404);
    }
  }

  async info(limit = DEFAULT_COMMITS): Promise<GitInfo> {
    const manifest = await this.project.manifest();
    const paths = ["--", manifest.trees, manifest.nodes];
    const n = Math.max(1, Math.min(MAX_COMMITS, Math.floor(limit) || DEFAULT_COMMITS));
    const [branch, head, refs, log, status] = await Promise.all([
      this.run(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => ""),
      this.run(["rev-parse", "--verify", "--quiet", "HEAD"]).catch(() => ""),
      this.run(["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"]),
      // One extra tells whether there are more. --parents rewrites parents to commits that touched
      // the paths, so the graph stays connected. An empty repository has no HEAD to log.
      this.run(["log", `-n${n + 1}`, "--topo-order", "--parents", "--decorate=short", "--format=%H%x1f%P%x1f%h%x1f%an%x1f%aI%x1f%D%x1f%s%x1e", "HEAD", ...paths]).catch(() => ""),
      this.run(["status", "--porcelain", "-z", ...paths]),
    ]);
    const names = refs.split("\n").filter(Boolean);
    const commits: GitCommit[] = log
      .split("\x1e")
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [sha, parents, short, author, date, refs, subject] = r.split("\x1f");
        return {
          sha,
          short,
          author,
          date,
          subject,
          parents: parents.split(" ").filter(Boolean),
          refs: refs.split(", ").filter(Boolean),
        };
      });
    const more = commits.length > n;
    if (more) commits.length = n;
    return {
      available: true,
      branch: branch.trim() || null,
      head: head.trim() || null,
      branches: names.filter((n) => n.startsWith("refs/heads/")).map((n) => n.slice("refs/heads/".length)),
      tags: names.filter((n) => n.startsWith("refs/tags/")).map((n) => n.slice("refs/tags/".length)),
      commits,
      more,
      dirty: status.length > 0,
    };
  }

  /** The project's files at commit `sha`, read straight from the object store. */
  private source(sha: string): ProjectSource {
    const check = (rel: string) => {
      this.project.resolvePath(rel); // refuses paths outside the project
      return posix.normalize(rel);
    };
    return {
      read: async (rel) => {
        try {
          return await this.run(["cat-file", "blob", `${sha}:./${check(rel)}`]);
        } catch {
          return undefined;
        }
      },
      listXml: async (rel) => {
        // ls-tree prints paths relative to the working directory, which is the project root.
        const out = await this.run(["ls-tree", "-r", "-z", "--name-only", sha, "--", check(rel)]);
        return out
          .split("\0")
          .filter((p) => p.endsWith(".xml"))
          .sort();
      },
    };
  }

  async snapshot(rev: string): Promise<RevSnapshot> {
    if (rev === WORKTREE) return { rev, sha: null, label: "Working tree", snapshot: await this.project.load() };
    const sha = await this.resolve(rev);
    let snapshot = this.cache.get(sha);
    if (!snapshot) {
      snapshot = await this.project.load(this.source(sha));
      this.cache.set(sha, snapshot);
      if (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
    }
    const short = sha.slice(0, 7);
    return { rev, sha, label: rev.startsWith(short) || sha.startsWith(rev) ? short : `${rev} · ${short}`, snapshot };
  }
}
