import { describe, expect, it } from "vitest";
import { parseTreeFile } from "../src/server/xml_read.ts";
import { findNode, type BTNode, type TreeDef } from "../src/shared/model.ts";
import { diffTreeDefs, diffTrees, isChanged, type TreeDiff } from "../src/shared/tree_diff.ts";

const trees = (body: string, file = "t.xml"): TreeDef[] => parseTreeFile(`<root BTCPP_format="4">${body}</root>`, file).trees;
const root = (body: string): BTNode => trees(`<BehaviorTree ID="T">${body}</BehaviorTree>`)[0].root!;

/** Diffs two tree bodies and summarizes the result by node label (name, else type). */
function diff(a: string, b: string) {
  const oldRoot = root(a);
  const newRoot = root(b);
  const d = diffTrees(oldRoot, newRoot);
  const label = (r: BTNode, uid: string) => {
    const n = findNode(r, uid)!;
    return n.attrs.name ?? n.type;
  };
  const changed = [...d.matched.values()].filter(isChanged);
  return {
    d,
    oldRoot,
    newRoot,
    added: [...d.added].map((u) => label(newRoot, u)),
    removed: [...d.removed].map((u) => label(oldRoot, u)),
    moved: changed.filter((c) => c.moved).map((c) => label(newRoot, c.newUid)),
    reordered: changed.filter((c) => c.reordered).map((c) => label(newRoot, c.newUid)),
    edited: changed.filter((c) => c.type || Object.keys(c.attrs).length).map((c) => label(newRoot, c.newUid)),
  };
}

const unchanged = (d: TreeDiff) => expect(d.changes).toBe(0);

const BASE = `
  <Sequence name="main">
    <Fallback name="ready">
      <IsBatteryOk name="battery"/>
      <Charge name="charge"/>
    </Fallback>
    <MoveBase name="go" goal="{target}"/>
    <Say name="done" text="arrived"/>
  </Sequence>`;

describe("diffTrees", () => {
  it("finds nothing between identical trees", () => {
    const r = diff(BASE, BASE);
    unchanged(r.d);
    expect(r.d.matched.size).toBe(6);
  });

  it("ignores attribute order and v3 explicit-category syntax", () => {
    const r = diff(
      `<Sequence><MoveBase goal="{a}" name="go"/><Action ID="Say" text="hi"/></Sequence>`,
      `<Sequence><MoveBase name="go" goal="{a}"/><Say text="hi"/></Sequence>`,
    );
    unchanged(r.d);
  });

  it("reports attribute changes per attribute", () => {
    const r = diff(BASE, BASE.replace(`goal="{target}"`, `goal="{home}" speed="2"`));
    expect(r.edited).toEqual(["go"]);
    expect(r.d.changes).toBe(1);
    const c = r.d.matched.get(findNode(r.newRoot, "n5")!.uid)!;
    expect(c.attrs).toEqual({ goal: { old: "{target}", new: "{home}" }, speed: { old: undefined, new: "2" } });
  });

  it("does not trust positional uids across versions", () => {
    // Inserting a node first shifts every uid after it; the diff must still pair nodes by content.
    const r = diff(BASE, BASE.replace(`<Fallback name="ready">`, `<Log name="start"/><Fallback name="ready">`));
    expect(r.added).toEqual(["start"]);
    expect(r.d.changes).toBe(1);
    expect(r.moved).toEqual([]);
    expect(r.reordered).toEqual([]);
    const go = (x: BTNode) => x.children.find((c) => c.attrs.name === "go")!.uid;
    expect(r.d.oldToNew.get(go(r.oldRoot))).toBe(go(r.newRoot));
    expect(go(r.oldRoot)).not.toBe(go(r.newRoot));
  });

  it("reports removed subtrees", () => {
    const r = diff(BASE, BASE.replace(/<Fallback[\s\S]*<\/Fallback>/, ""));
    expect(r.removed.sort()).toEqual(["battery", "charge", "ready"]);
    expect(r.d.changes).toBe(3);
  });

  it("reports a subtree moved to another parent as one move", () => {
    const r = diff(
      BASE,
      `<Sequence name="main">
        <Fallback name="ready">
          <IsBatteryOk name="battery"/>
          <Charge name="charge"/>
          <Say name="done" text="arrived"/>
        </Fallback>
        <MoveBase name="go" goal="{target}"/>
      </Sequence>`,
    );
    expect(r.moved).toEqual(["done"]);
    expect(r.d.changes).toBe(1);
  });

  it("reports the fewest siblings needed to explain a reorder", () => {
    const r = diff(
      `<Sequence><A name="a"/><B name="b"/><C name="c"/><D name="d"/></Sequence>`,
      `<Sequence><B name="b"/><C name="c"/><D name="d"/><A name="a"/></Sequence>`,
    );
    expect(r.reordered).toEqual(["a"]);
    expect(r.d.changes).toBe(1);
  });

  it("treats wrapping in a decorator as an added parent", () => {
    const r = diff(BASE, BASE.replace(`<MoveBase name="go" goal="{target}"/>`, `<Retry num_attempts="3"><MoveBase name="go" goal="{target}"/></Retry>`));
    expect(r.added).toEqual(["Retry"]);
    expect(r.moved).toEqual(["go"]);
    expect(r.edited).toEqual([]);
  });

  it("reports a type change on a control node that kept its children", () => {
    const r = diff(BASE, BASE.replace(/<(\/?)Fallback/g, "<$1ReactiveFallback"));
    expect(r.edited).toEqual(["ready"]);
    const c = [...r.d.matched.values()].find((c) => c.type)!;
    expect(c.type).toEqual({ old: "Fallback", new: "ReactiveFallback" });
    expect(r.d.changes).toBe(1);
  });

  it("matches a renamed-type leaf by name", () => {
    const r = diff(BASE, BASE.replace(`<Charge name="charge"/>`, `<DockAndCharge name="charge"/>`));
    expect(r.edited).toEqual(["charge"]);
    expect(r.added).toEqual([]);
  });

  it("places one inserted copy among identical siblings", () => {
    const r = diff(
      `<Sequence><AlwaysSuccess/><Wait msec="5"/><AlwaysSuccess/></Sequence>`,
      `<Sequence><AlwaysSuccess/><Wait msec="5"/><AlwaysSuccess/><AlwaysSuccess/></Sequence>`,
    );
    expect(r.added).toEqual(["AlwaysSuccess"]);
    expect(r.d.changes).toBe(1);
  });

  it("keeps repeated identical subtrees under their own parents", () => {
    const sub = `<Fallback><IsOk/><Fix/></Fallback>`;
    const r = diff(
      `<Sequence><Sequence name="left">${sub}</Sequence><Sequence name="right">${sub}</Sequence></Sequence>`,
      `<Sequence><Sequence name="left">${sub}<Log/></Sequence><Sequence name="right">${sub}</Sequence></Sequence>`,
    );
    expect(r.added).toEqual(["Log"]);
    expect(r.moved).toEqual([]);
    expect(r.d.changes).toBe(1);
  });

  it("handles an edited subtree that no longer matches anything exactly", () => {
    const r = diff(BASE, BASE.replace(`<IsBatteryOk name="battery"/>`, `<IsBatteryOk name="battery" min="20"/>`).replace(`text="arrived"`, `text="here"`));
    expect(r.edited.sort()).toEqual(["battery", "done"]);
    expect(r.d.changes).toBe(2);
  });

  it("handles empty trees on either side", () => {
    const n = root(BASE);
    expect(diffTrees(null, n).added.size).toBe(6);
    expect(diffTrees(n, null).removed.size).toBe(6);
    unchanged(diffTrees(null, null));
  });
});

describe("diffTreeDefs", () => {
  it("pairs trees by ID across files and detects renames", () => {
    const old = [
      ...trees(`<BehaviorTree ID="Main"><Sequence><SubTree ID="Dock"/></Sequence></BehaviorTree><BehaviorTree ID="Dock"><Charge/></BehaviorTree>`, "a.xml"),
      ...trees(`<BehaviorTree ID="Patrol"><Sequence><Go/><Look/></Sequence></BehaviorTree><BehaviorTree ID="Gone"><Wait/></BehaviorTree>`, "b.xml"),
    ];
    const next = [
      ...trees(`<BehaviorTree ID="Main"><Sequence><SubTree ID="Dock"/></Sequence></BehaviorTree>`, "a.xml"),
      ...trees(`<BehaviorTree ID="Dock" _description="docks"><Charge/></BehaviorTree>`, "c.xml"),
      ...trees(`<BehaviorTree ID="Roam"><Sequence><Go/><Look/></Sequence></BehaviorTree><BehaviorTree ID="New"><Sequence><Wait/><Log/></Sequence></BehaviorTree>`, "b.xml"),
    ];
    const byId = Object.fromEntries(diffTreeDefs(old, next).map((d) => [d.new?.id ?? d.old!.id, d]));
    expect(Object.fromEntries(Object.entries(byId).map(([k, d]) => [k, d.status]))).toEqual({
      Main: "unchanged",
      Dock: "changed",
      Roam: "renamed",
      New: "added",
      Gone: "removed",
    });
    expect(byId.Dock.meta.file).toEqual({ old: "a.xml", new: "c.xml" });
    expect(byId.Dock.meta.description).toEqual({ old: undefined, new: "docks" });
    expect(byId.Roam.meta.id).toEqual({ old: "Patrol", new: "Roam" });
    expect(byId.Roam.nodes.changes).toBe(0);
  });
});
