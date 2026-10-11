import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findGit, useBundledGit } from "../src/server/git_binary.ts";
import { Project, ProjectError } from "../src/server/project.ts";
import { WORKTREE } from "../src/shared/model.ts";

const DEMO = join(import.meta.dirname, "..", "examples", "demo_project");

/** A repo with the demo project in a subdirectory, as projects usually are. */
async function repoWithProject() {
  const repo = await mkdtemp(join(tmpdir(), "bt-editor-git-"));
  const root = join(repo, "robot", "bt");
  await mkdir(join(repo, "robot"));
  await cp(DEMO, root, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-qm", "first");
  return { repo, root, git };
}

describe("git snapshots", () => {
  it("reads the project at a revision without touching the disk state", async () => {
    const { root, git } = await repoWithProject();
    const p = new Project(root);
    const first = (await p.load()).trees.map((t) => t.id).sort();

    // A second commit removes a tree file and edits another.
    await rm(join(root, "trees", "recharge.xml"));
    git("commit", "-qam", "drop recharge");
    git("tag", "v1");
    await writeFile(join(root, "trees", "extra.xml"), `<root BTCPP_format="4"><BehaviorTree ID="Extra"><AlwaysSuccess/></BehaviorTree></root>`);

    const repo = await p.git();
    if (typeof repo === "string") throw new Error(repo);
    const info = await repo.info();
    expect(info).toMatchObject({ available: true, branch: "main", branches: ["main"], tags: ["v1"], dirty: true });
    if (!info.available) return;
    expect(info.commits.map((c) => c.subject)).toEqual(["drop recharge", "first"]);

    const old = await repo.snapshot("HEAD~1");
    expect(old.snapshot.trees.map((t) => t.id).sort()).toEqual(first);
    expect(old.label).toBe(`HEAD~1 · ${old.sha!.slice(0, 7)}`);
    expect(old.snapshot.files.map((f) => f.path)).toContain("trees/recharge.xml");

    const tagged = await repo.snapshot("v1");
    expect(tagged.snapshot.trees.some((t) => t.file === "trees/recharge.xml")).toBe(false);
    expect(tagged.snapshot.trees.some((t) => t.id === "Extra")).toBe(false);

    const disk = await repo.snapshot(WORKTREE);
    expect(disk.sha).toBeNull();
    expect(disk.snapshot.trees.some((t) => t.id === "Extra")).toBe(true);
  });

  it("refuses option-like and unknown revisions", async () => {
    const { root } = await repoWithProject();
    const repo = await new Project(root).git();
    if (typeof repo === "string") throw new Error(repo);
    await expect(repo.snapshot("--output=/tmp/x")).rejects.toBeInstanceOf(ProjectError);
    await expect(repo.snapshot("HEAD~5")).rejects.toThrow(/Unknown revision/);
  });

  it("reports projects outside a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bt-editor-nogit-"));
    await cp(DEMO, dir, { recursive: true });
    expect(await new Project(dir).git()).toBe("This project is not in a git repository");
  });
});

describe("bundled git", () => {
  const path = process.env.PATH;
  afterEach(() => {
    process.env.PATH = path;
  });

  it("is used when there's no git on the PATH", async () => {
    const { root } = await repoWithProject();
    process.env.PATH = await mkdtemp(join(tmpdir(), "bt-editor-nopath-"));
    useBundledGit(join(import.meta.dirname, "..", "node_modules", "dugite", "git"));
    expect(await findGit()).toMatchObject({ bundled: true });

    const repo = await new Project(root).git();
    if (typeof repo === "string") throw new Error(repo);
    const info = await repo.info();
    expect(info.available && info.commits.map((c) => c.subject)).toEqual(["first"]);
  });

  it("says so when there's no git at all", async () => {
    const { root } = await repoWithProject();
    process.env.PATH = await mkdtemp(join(tmpdir(), "bt-editor-nopath-"));
    useBundledGit(join(tmpdir(), "no-such-git"));
    expect(await new Project(root).git()).toMatch(/needs git/);
  });
});
