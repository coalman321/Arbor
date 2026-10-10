import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace } from "../src/server/workspace.ts";

const DEMO = join(import.meta.dirname, "..", "examples", "demo_project");

async function setup(limit = false) {
  const dir = await mkdtemp(join(tmpdir(), "bt-editor-ws-"));
  await cp(DEMO, join(dir, "demo"), { recursive: true });
  const ws = new Workspace(limit ? join(dir) : null, join(dir, ".config"));
  return { dir, ws };
}

describe("workspace", () => {
  it("opens projects, remembers them, and refuses directories that aren't projects", async () => {
    const { dir, ws } = await setup();
    await expect(ws.open(dir)).rejects.toThrow(/not a project/);
    const changes: (string | undefined)[] = [];
    ws.onChange((p) => changes.push(p?.root));
    await ws.open(join(dir, "demo"));
    expect(ws.project?.root).toBe(join(dir, "demo"));
    expect(changes).toEqual([join(dir, "demo")]);

    await ws.create(join(dir, "fresh"));
    expect(existsSync(join(dir, "fresh", "trees", "main.xml"))).toBe(true);
    await expect(ws.create(join(dir, "demo"))).rejects.toThrow(/already contains a project/);

    const info = await ws.info();
    expect(info.current).toBe(join(dir, "fresh"));
    expect(info.recent.map((r) => r.path)).toEqual([join(dir, "fresh"), join(dir, "demo")]);
    expect(info.recent[1]).toMatchObject({ name: "demo_project", exists: true });
    await ws.forget(join(dir, "demo"));
    expect((await ws.info()).recent.map((r) => r.path)).toEqual([join(dir, "fresh")]);
  });

  it("browses directories, marking projects and listing .xml files", async () => {
    const { dir, ws } = await setup();
    await writeFile(join(dir, "loose.xml"), "<root/>");
    await writeFile(join(dir, "notes.txt"), "");
    const r = await ws.browse(dir);
    expect(r.entries).toEqual([
      { name: "demo", kind: "dir", isProject: true },
      { name: "loose.xml", kind: "xml" },
    ]);
    expect(r.parent).not.toBeNull();
    await expect(ws.browse("relative/path")).rejects.toThrow(/absolute/);
  });

  it("keeps everything under --root", async () => {
    const { dir, ws } = await setup(true);
    expect((await ws.browse(dir)).parent).toBeNull();
    await expect(ws.browse(tmpdir())).rejects.toThrow(/Only paths under/);
    await expect(ws.open(join(dir, "..", "x"))).rejects.toThrow(/Only paths under/);
  });

  it("imports tree files, refusing broken files and duplicate tree IDs", async () => {
    const { dir, ws } = await setup();
    await expect(ws.importTree(join(dir, "x.xml"))).rejects.toThrow(/No project/);
    await ws.open(join(dir, "demo"));

    const ok = join(dir, "patrol.xml");
    await writeFile(ok, `<root BTCPP_format="4"><BehaviorTree ID="Patrol"><AlwaysSuccess/></BehaviorTree></root>`);
    expect(await ws.importTree(ok)).toEqual({ path: "trees/patrol.xml", treeIds: ["Patrol"] });
    expect(await readFile(join(dir, "demo", "trees", "patrol.xml"), "utf8")).toContain("Patrol");
    // Importing it again clashes on the tree ID, not just the file name.
    await expect(ws.importTree(ok)).rejects.toThrow(/already has a tree named "Patrol"/);

    const renamed = join(dir, "sub");
    await mkdir(renamed);
    await writeFile(join(renamed, "patrol.xml"), `<root BTCPP_format="4"><BehaviorTree ID="Patrol2"/></root>`);
    expect((await ws.importTree(join(renamed, "patrol.xml"))).path).toBe("trees/patrol_2.xml");

    await writeFile(join(dir, "bad.xml"), "<root><BehaviorTree ID='x'>");
    await expect(ws.importTree(join(dir, "bad.xml"))).rejects.toThrow(/bad.xml/);
    await writeFile(join(dir, "empty.xml"), `<root BTCPP_format="4"/>`);
    await expect(ws.importTree(join(dir, "empty.xml"))).rejects.toThrow(/no <BehaviorTree>/);
    await expect(ws.importTree(join(dir, "demo", "trees", "main.xml"))).rejects.toThrow(/already/);
  });
});
