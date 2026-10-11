import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadTrees, type XmlFile } from "../src/load.ts";

const DEMO = join(import.meta.dirname, "..", "..", "..", "examples", "demo_project");
const read = (rel: string): XmlFile => ({ path: rel, xml: readFileSync(join(DEMO, rel), "utf8") });
const demoFiles = () => readdirSync(join(DEMO, "trees")).filter((f) => f.endsWith(".xml")).sort().map((f) => read(`trees/${f}`));

const tree = (id: string, body = "<AlwaysSuccess/>") => `<root BTCPP_format="4"><BehaviorTree ID="${id}">${body}</BehaviorTree></root>`;

describe("loadTrees", () => {
  it("loads the demo project", () => {
    const loaded = loadTrees({ spec: read("nodes.xml"), files: demoFiles() });
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.trees.map((t) => t.id)).toEqual(["FetchObject", "MainTree", "Recharge"]);
    expect(loaded.files.find((f) => f.path === "trees/main.xml")).toMatchObject({ mainTree: "MainTree", treeIds: ["MainTree"] });
    // Builtins, the spec, and one SubTree model per tree.
    expect(loaded.models.get("Sequence")?.source).toBe("builtin");
    expect(loaded.models.get("MoveTo")?.source).toBe("spec");
    expect(loaded.models.get("SubTree:Recharge")?.category).toBe("SubTree");
  });

  it("keeps going past a broken file, and marks it read-only", () => {
    const loaded = loadTrees({ files: [{ path: "a.xml", xml: "<root><oops" }, { path: "b.xml", xml: tree("B") }] });
    expect(loaded.trees.map((t) => t.id)).toEqual(["B"]);
    expect(loaded.files[0].readOnlyReason).toBeTruthy();
    expect(loaded.diagnostics).toMatchObject([{ severity: "error", file: "a.xml" }]);
  });

  it("rejects a tree ID defined twice", () => {
    const loaded = loadTrees({ files: [{ path: "a.xml", xml: tree("T") }, { path: "b.xml", xml: tree("T") }] });
    expect(loaded.trees).toHaveLength(1);
    expect(loaded.files[1].readOnlyReason).toBe('Tree ID "T" is already defined in a.xml');
  });

  it("falls back to node models declared in tree files", () => {
    const xml = `<root BTCPP_format="4"><BehaviorTree ID="T"><Beep/></BehaviorTree>
      <TreeNodesModel><Action ID="Beep"/></TreeNodesModel></root>`;
    const loaded = loadTrees({ specPath: "nodes.xml", files: [{ path: "t.xml", xml }] });
    expect(loaded.models.get("Beep")?.category).toBe("Action");
    expect(loaded.diagnostics).toMatchObject([{ severity: "info", message: expect.stringContaining("add them to nodes.xml") }]);
  });
});
