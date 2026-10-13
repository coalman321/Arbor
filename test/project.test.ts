import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Project, ProjectError } from "../src/server/project.ts";
import {
  mapRuntimeTree,
  parseSpec,
  parseSpecFile,
  parseTreeFile,
  projectModels,
  type RuntimeNode,
  type TreeDef,
} from "@coalman321/arborist";
import { validateProject } from "../src/shared/validate.ts";
import { serializeSpecFile, serializeTreeFile } from "../src/shared/xml_write.ts";

const DEMO = join(import.meta.dirname, "..", "examples", "demo_project");
const ROBOT = join(import.meta.dirname, "..", "examples", "my_robot_trees");

async function demoCopy(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bt-editor-test-"));
  await cp(DEMO, dir, { recursive: true });
  return dir;
}

describe("xml", () => {
  it("round-trips the demo tree files byte for byte", async () => {
    for (const f of ["main.xml", "fetch.xml", "recharge.xml"]) {
      const xml = await readFile(join(DEMO, "trees", f), "utf8");
      const parsed = parseTreeFile(xml, `trees/${f}`);
      expect(parsed.warnings).toEqual([]);
      expect(serializeTreeFile(parsed)).toBe(xml);
    }
  });

  it("round-trips the spec file", async () => {
    const xml = await readFile(join(DEMO, "nodes.xml"), "utf8");
    const models = parseSpecFile(xml);
    expect(models.map((m) => m.id)).toContain("MoveTo");
    expect(models.find((m) => m.id === "IsBatteryOk")?.ports[0]).toMatchObject({
      name: "min_percent",
      direction: "input",
      type: "double",
      default: "20",
    });
    expect(serializeSpecFile(models)).toBe(xml);
  });

  it("round-trips a spec with enums", async () => {
    const xml = await readFile(join(ROBOT, "nodes.xml"), "utf8");
    const spec = parseSpec(xml);
    expect(spec.warnings).toEqual([]);
    expect(spec.enums.find((e) => e.type === "ShooterStates")?.values.map((v) => v.name)).toEqual(["IDLE", "SHOOT"]);
    expect(serializeSpecFile(spec.models, spec.enums)).toBe(xml);
    const withValues = serializeSpecFile([], [{ type: "M", values: [{ name: "A", value: 0, description: "a < b" }, { name: "B" }] }]);
    expect(parseSpec(withValues).enums).toEqual([{ type: "M", values: [{ name: "A", value: 0, description: "a < b" }, { name: "B" }] }]);
  });

  it("keeps a node type's icon in its MetaFields", () => {
    const xml = serializeSpecFile([{ id: "Dock", category: "Action", ports: [], source: "spec", metadata: { icon: "🔌" } }]);
    expect(xml).toContain("<MetaFields>");
    expect(parseSpecFile(xml)[0].metadata).toEqual({ icon: "🔌" });
  });

  it("normalizes v3-style explicit category tags and escapes attributes", () => {
    const parsed = parseTreeFile(
      `<root BTCPP_format="4"><BehaviorTree ID="T"><Sequence>` +
        `<Action ID="Say" message="a &amp; b &lt; &quot;c&quot;"/>` +
        `<Script code="x := 1&#10;y := 2"/>` +
        `</Sequence></BehaviorTree></root>`,
      "trees/t.xml",
    );
    const seq = parsed.trees[0].root!;
    expect(seq.children[0]).toMatchObject({ type: "Say", attrs: { message: 'a & b < "c"' } });
    expect(seq.children[1].attrs.code).toBe("x := 1\ny := 2");
    const out = serializeTreeFile(parsed);
    expect(out).toContain('<Say message="a &amp; b &lt; &quot;c&quot;"/>');
    expect(out).toContain('<Script code="x := 1&#10;y := 2"/>');
    expect(parseTreeFile(out, "trees/t.xml").trees[0].root!.children[1].attrs.code).toBe("x := 1\ny := 2");
  });

  it("rejects malformed XML", () => {
    expect(() => parseTreeFile("<root><BehaviorTree ID='x'><Sequence></root>", "t.xml")).toThrow();
    expect(() => parseTreeFile("<notroot/>", "t.xml")).toThrow(/Missing <root>/);
  });
});

describe("project", () => {
  it("loads the demo project cleanly", async () => {
    const snap = await new Project(DEMO).load();
    expect(snap.diagnostics).toEqual([]);
    expect(snap.trees.map((t) => t.id).sort()).toEqual(["FetchObject", "MainTree", "Recharge"]);
    expect(snap.trees.find((t) => t.id === "FetchObject")?.ports.map((p) => p.name)).toEqual(["object", "destination", "attempts"]);

    const trees = new Map(snap.trees.map((t) => [t.id, t]));
    const models = projectModels(snap.specModels, snap.trees);
    expect(validateProject(trees, models, snap.files.map((f) => f.mainTree))).toEqual([]);
  });

  it("loads the robot example, whose ports use enums, cleanly", async () => {
    const snap = await new Project(ROBOT).load();
    expect(snap.diagnostics).toEqual([]);
    expect(snap.specEnums.map((e) => e.type)).toEqual(["SwerveStates", "IntakeStates", "ShooterStates"]);
    const trees = new Map(snap.trees.map((t) => [t.id, t]));
    const enums = new Map(snap.specEnums.map((e) => [e.type, e]));
    const msgs = validateProject(trees, projectModels(snap.specModels, snap.trees), [], enums).map((d) => d.message);
    expect(msgs.filter((m) => /" is (not|out of range)/.test(m))).toEqual([]);
  });

  it("keeps the spec's enums when saving node types", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bt-editor-test-"));
    await cp(ROBOT, dir, { recursive: true });
    const p = new Project(dir);
    const snap = await p.load();
    await p.saveSpec(snap.specModels.filter((m) => m.id !== "IsShooterReady"));
    const after = await p.load();
    expect(after.specModels.some((m) => m.id === "IsShooterReady")).toBe(false);
    expect(after.specEnums).toEqual(snap.specEnums);
    await p.saveSpec(after.specModels, []);
    expect((await p.load()).specEnums).toEqual([]);
  });

  it("refuses paths outside the trees directory", async () => {
    const p = new Project(DEMO);
    await expect(p.treeFilePath("../etc/passwd")).rejects.toThrow(ProjectError);
    await expect(p.treeFilePath("nodes.xml")).rejects.toThrow(/under trees/);
    await expect(p.treeFilePath("trees/x.txt")).rejects.toThrow(/under trees/);
    await expect(p.treeFilePath("trees/../../x.xml")).rejects.toThrow(ProjectError);
    await expect(p.treeFilePath("trees/sub/x.xml")).resolves.toContain("x.xml");
  });

  it("saves, detects external edits and marks duplicate IDs read-only", async () => {
    const dir = await demoCopy();
    const p = new Project(dir);
    const snap = await p.load();
    const recharge = snap.trees.find((t) => t.id === "Recharge")!;
    const base = p.knownVersion("trees/recharge.xml");

    recharge.root!.children.pop();
    const { version } = await p.saveTreeFile({ path: "trees/recharge.xml", includes: [], trees: [recharge], baseVersion: base });
    expect(version).not.toBe(base);
    expect(await readFile(join(dir, "trees/recharge.xml"), "utf8")).not.toContain("ChargeUntil");

    // Someone else edits the file: a save based on the old version is refused.
    await writeFile(join(dir, "trees/recharge.xml"), (await readFile(join(dir, "trees/recharge.xml"), "utf8")) + "\n");
    await expect(p.saveTreeFile({ path: "trees/recharge.xml", includes: [], trees: [recharge], baseVersion: version })).rejects.toThrow(
      /changed on disk/,
    );

    await writeFile(join(dir, "trees/dup.xml"), `<root BTCPP_format="4"><BehaviorTree ID="Recharge"/></root>`);
    const again = await p.load();
    // Files load alphabetically, so the second definition (in recharge.xml) is the one locked.
    expect(again.files.find((f) => f.path === "trees/recharge.xml")?.readOnlyReason).toMatch(/already defined in trees\/dup.xml/);
    expect(again.diagnostics.some((d) => d.severity === "error")).toBe(true);
  });
});

describe("validation", () => {
  const tree = (root: TreeDef["root"], id = "T"): TreeDef => ({ id, file: "trees/t.xml", ports: [], attrs: {}, root });
  const node = (type: string, attrs: Record<string, string> = {}, children: TreeDef["root"][] = [], uid = type) => ({
    uid,
    type,
    attrs,
    children: children as NonNullable<TreeDef["root"]>[],
  });

  it("reports unknown nodes, child counts, missing ports and subtree recursion", () => {
    const a = tree(node("Sequence", {}, [node("Bogus"), node("Inverter"), node("Sleep"), node("SubTree", { ID: "B" })]), "A");
    const b = tree(node("SubTree", { ID: "A" }, [], "s"), "B");
    const trees = new Map([
      ["A", a],
      ["B", b],
    ]);
    const msgs = validateProject(trees, projectModels([], trees.values()), []).map((d) => d.message);
    expect(msgs).toContainEqual(expect.stringMatching(/Unknown node type "Bogus"/));
    expect(msgs).toContainEqual(expect.stringMatching(/Inverter must have 1 child, has 0/));
    expect(msgs).toContainEqual(expect.stringMatching(/input port "msec" is not set/));
    expect(msgs).toContainEqual(expect.stringMatching(/recursively includes/));
  });

  it("warns about literals that are not values of the port's enum", () => {
    const models = projectModels(
      [{ id: "SetMode", category: "Action", source: "spec", ports: [{ name: "mode", direction: "input", type: "Mode" }] }],
      [],
    );
    const enums = new Map([["Mode", { type: "Mode", values: [{ name: "SLOW", value: 0 }, { name: "FAST", value: 1 }] }]]);
    const check = (mode: string) => {
      const trees = new Map([["T", tree(node("SetMode", { mode }))]]);
      return validateProject(trees, models, [], enums).map((d) => d.message);
    };
    expect(check("FAST")).toEqual([]);
    expect(check("1")).toEqual([]);
    expect(check("{mode}")).toEqual([]);
    expect(check("FASTER")).toEqual(['SetMode: "FASTER" is not a Mode value (port "mode")']);
    expect(check("7")).toEqual(['SetMode: "7" is not a Mode value (port "mode")']);
  });

  it("checks enum ports of SubTrees: values passed in and the tree's defaults", () => {
    const enums = new Map([["Mode", { type: "Mode", values: [{ name: "SLOW" }, { name: "FAST" }] }]]);
    const inner: TreeDef = { ...tree(node("AlwaysSuccess"), "Inner"), ports: [{ name: "mode", direction: "input", type: "Mode", default: "TURBO" }] };
    const outer = tree(node("Sequence", {}, [node("SubTree", { ID: "Inner", mode: "FAST" }, [], "a"), node("SubTree", { ID: "Inner", mode: "SLOWER" }, [], "b")]), "Outer");
    const trees = new Map([
      ["Inner", inner],
      ["Outer", outer],
    ]);
    const msgs = validateProject(trees, projectModels([], trees.values()), [], enums).map((d) => d.message);
    expect(msgs).toEqual(['Tree "Inner": default "TURBO" of port "mode" is not a Mode value', 'SubTree Inner: "SLOWER" is not a Mode value (port "mode")']);
  });
});

describe("live mapping", () => {
  it("pairs runtime UIDs with editor nodes through SubTrees", async () => {
    const snap = await new Project(DEMO).load();
    const trees = new Map(snap.trees.map((t) => [t.id, t]));
    // Build what a robot would report by walking the trees the way BT::Tree::applyVisitor does.
    const runtime: RuntimeNode[] = [];
    let uid = 1;
    const emit = (n: NonNullable<TreeDef["root"]>, parent: number | null) => {
      const me = uid++;
      runtime.push({ uid: me, parent, type: n.type, name: n.attrs.name ?? n.type });
      if (n.type === "SubTree") emit(trees.get(n.attrs.ID)!.root!, me);
      else n.children.forEach((c) => emit(c, me));
    };
    emit(trees.get("MainTree")!.root!, null);

    const m = mapRuntimeTree("MainTree", runtime, trees);
    expect(m.mismatches).toEqual([]);
    expect(m.byRuntimeUid.size).toBe(runtime.length);
    const pick = runtime.find((r) => r.type === "Pick")!;
    const mapped = m.byRuntimeUid.get(pick.uid)!;
    expect(mapped.treeId).toBe("FetchObject");
    expect(mapped.path.split("/")).toHaveLength(2);

    // A robot running an older version of the tree: the extra node is reported, the rest still maps.
    runtime.push({ uid: 999, parent: runtime[0].uid, type: "AlwaysSuccess", name: "extra" });
    const m2 = mapRuntimeTree("MainTree", runtime, trees);
    expect(m2.mismatches).toHaveLength(1);
    expect(m2.unmatched).toBe(1);
    expect(m2.byRuntimeUid.size).toBe(runtime.length - 1);
  });
});
