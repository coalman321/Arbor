import { describe, expect, it } from "vitest";
import { projectModels, type BTNode } from "@coalman321/arborist";
import { blackboardKeyTypes, insertAt, moveNode, removeNode, reorder, unwrapNode, wrapNode } from "../src/web/tree_ops.ts";

const n = (uid: string, children: BTNode[] = [], type = "Sequence"): BTNode => ({ uid, type, attrs: {}, children });
const shape = (x: BTNode | null): unknown => (x ? (x.children.length ? { [x.uid]: x.children.map(shape) } : x.uid) : null);

// root
//  ├─ a
//  │  ├─ a1
//  │  └─ a2
//  └─ b
const tree = () => n("root", [n("a", [n("a1"), n("a2")]), n("b")]);

describe("tree_ops", () => {
  it("inserts before, after and inside", () => {
    expect(shape(insertAt(tree(), "a1", "before", n("x")))).toEqual({ root: [{ a: ["x", "a1", "a2"] }, "b"] });
    expect(shape(insertAt(tree(), "a1", "after", n("x")))).toEqual({ root: [{ a: ["a1", "x", "a2"] }, "b"] });
    expect(shape(insertAt(tree(), "b", "inside", n("x")))).toEqual({ root: [{ a: ["a1", "a2"] }, { b: ["x"] }] });
    expect(insertAt(tree(), "root", "after", n("x"))).toBeNull();
  });

  it("moves subtrees and refuses cycles", () => {
    expect(shape(moveNode(tree(), "a2", "b", "inside"))).toEqual({ root: [{ a: ["a1"] }, { b: ["a2"] }] });
    expect(shape(moveNode(tree(), "b", "a1", "before"))).toEqual({ root: [{ a: ["b", "a1", "a2"] }] });
    expect(moveNode(tree(), "a", "a1", "inside")).toBeNull();
    expect(moveNode(tree(), "root", "b", "inside")).toBeNull();
  });

  it("shares untouched subtrees", () => {
    const t = tree();
    const next = moveNode(t, "a2", "a1", "before")!;
    expect(next.children[1]).toBe(t.children[1]);
  });

  it("reorders, removes, wraps and unwraps", () => {
    expect(shape(reorder(tree(), "a2", -1))).toEqual({ root: [{ a: ["a2", "a1"] }, "b"] });
    expect(shape(reorder(tree(), "a1", -1))).toEqual(shape(tree()));
    expect(shape(removeNode(tree(), "a"))).toEqual({ root: ["b"] });
    expect(removeNode(tree(), "root")).toBeNull();
    expect(shape(wrapNode(tree(), "b", n("w", [], "Inverter")))).toEqual({ root: [{ a: ["a1", "a2"] }, { w: ["b"] }] });
    expect(shape(wrapNode(tree(), "root", n("w", [], "Inverter")))).toEqual({ w: [{ root: [{ a: ["a1", "a2"] }, "b"] }] });
    expect(shape(unwrapNode(tree(), "a"))).toEqual({ root: ["a1", "a2", "b"] });
  });
});

describe("blackboardKeyTypes", () => {
  it("types keys wired to typed ports, unless the ports disagree", () => {
    const models = projectModels(
      [
        { id: "SetMode", category: "Action", source: "spec", ports: [{ name: "mode", direction: "input", type: "Mode" }] },
        { id: "Wait", category: "Action", source: "spec", ports: [{ name: "msec", direction: "input", type: "int" }] },
      ],
      [],
    );
    const root: BTNode = {
      uid: "r",
      type: "Sequence",
      attrs: {},
      children: [
        { uid: "a", type: "SetMode", attrs: { mode: "{m}" }, children: [] },
        { uid: "b", type: "Wait", attrs: { msec: "{t}" }, children: [] },
        { uid: "c", type: "SetMode", attrs: { mode: "{t}" }, children: [] },
      ],
    };
    expect([...blackboardKeyTypes(root, models)]).toEqual([["m", "Mode"]]);
  });
});
