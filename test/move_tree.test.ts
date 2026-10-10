import { describe, expect, it } from "vitest";
import type { TreeDef } from "../src/shared/model.ts";
import { moveTreeToFile, undo, useStore, type FileState } from "../src/web/store.ts";

const tree = (id: string, file: string): TreeDef => ({ id, file, ports: [], attrs: {}, root: { uid: "n1", type: "AlwaysSuccess", attrs: {}, children: [] } });
const file = (path: string, treeIds: string[], mainTree?: string): FileState => ({ path, includes: [], treeIds, version: "v", dirty: false, mainTree });

function setup() {
  useStore.setState({
    manifest: { name: "p", nodes: "nodes.xml", trees: "trees", live: { url: "" } },
    trees: { A: tree("A", "trees/a.xml"), B: tree("B", "trees/a.xml"), C: tree("C", "trees/c.xml") },
    files: { "trees/a.xml": file("trees/a.xml", ["A", "B"], "A"), "trees/c.xml": file("trees/c.xml", ["C"], "C") },
    history: { A: { past: [{ ...tree("A", "trees/a.xml"), root: null }], future: [] } },
    toast: null,
  });
}
const s = () => useStore.getState();

describe("moving a tree between files", () => {
  it("moves into an existing file; main stays with the file that already has one", () => {
    setup();
    expect(moveTreeToFile("A", "trees/c.xml")).toBeNull();
    expect(s().trees.A.file).toBe("trees/c.xml");
    expect(s().files["trees/a.xml"]).toMatchObject({ treeIds: ["B"], dirty: true, mainTree: undefined });
    expect(s().files["trees/c.xml"]).toMatchObject({ treeIds: ["C", "A"], dirty: true, mainTree: "C" });
    expect(s().toast?.text).toMatch(/no longer a main tree/);
    // Undo history follows the tree, so undoing an edit doesn't put it back in the old file.
    undo("A");
    expect(s().trees.A.file).toBe("trees/c.xml");
  });

  it("moves into a new file, keeping main, and empties (deletes on save) the old one", () => {
    setup();
    expect(moveTreeToFile("C", "trees/sub/new.xml")).toBeNull();
    expect(s().files["trees/sub/new.xml"]).toMatchObject({ treeIds: ["C"], isNew: true, dirty: true, mainTree: "C" });
    expect(s().files["trees/c.xml"]).toMatchObject({ treeIds: [], deleted: true, dirty: true });
    // ...and back: the emptied file is revived rather than duplicated.
    expect(moveTreeToFile("C", "trees/c.xml")).toBeNull();
    expect(s().files["trees/c.xml"]).toMatchObject({ treeIds: ["C"], deleted: false, mainTree: "C" });
    expect(s().files["trees/sub/new.xml"]).toBeUndefined();
  });

  it("refuses bad destinations and read-only files", () => {
    setup();
    expect(moveTreeToFile("A", "other/x.xml")).toMatch(/under trees\//);
    expect(moveTreeToFile("A", "trees/x.txt")).toMatch(/\.xml/);
    expect(moveTreeToFile("A", "trees/../x.xml")).toMatch(/under trees\//);
    useStore.setState({ files: { ...s().files, "trees/c.xml": { ...s().files["trees/c.xml"], readOnlyReason: "dup" } } });
    expect(moveTreeToFile("A", "trees/c.xml")).toMatch(/read-only/);
    expect(moveTreeToFile("A", "trees/a.xml")).toBeNull(); // same file: nothing to do
    expect(s().files["trees/a.xml"].dirty).toBe(false);
  });
});
