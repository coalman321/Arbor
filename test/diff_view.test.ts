import { describe, expect, it } from "vitest";
import { parseTreeFile } from "../src/server/xml_read.ts";
import type { BTNode } from "../src/shared/model.ts";
import { diffTreeDefs } from "../src/shared/tree_diff.ts";
import { diffLines, mergeAll, type MergedTree } from "../src/web/diff_view.ts";

const trees = (body: string) => parseTreeFile(`<root BTCPP_format="4">${body}</root>`, "t.xml").trees;

const merge = (a: string, b: string): Record<string, MergedTree> => mergeAll(diffTreeDefs(trees(a), trees(b)));
const one = (a: string, b: string) => merge(`<BehaviorTree ID="T">${a}</BehaviorTree>`, `<BehaviorTree ID="T">${b}</BehaviorTree>`).T;

/** The merged tree as nested labels, each tagged with its mark: "Type:kind" (same is untagged). */
function shape(m: MergedTree, n: BTNode | null = m.def.root): unknown {
  if (!n) return null;
  const mark = m.marks.get(n.uid)!;
  const label = (n.attrs.name ?? n.type) + (mark.kind === "same" ? "" : `:${mark.kind}`) + (mark.nesting ? `(${mark.nesting})` : "");
  return n.children.length ? { [label]: n.children.map((c) => shape(m, c)) } : label;
}

describe("merged diff tree", () => {
  it("puts removed nodes back where they were", () => {
    const m = one(`<Sequence><A/><B/><C/></Sequence>`, `<Sequence><A/><C/><D/></Sequence>`);
    expect(shape(m)).toEqual({ Sequence: ["A", "B:removed", "C", "D:added"] });
    expect(m.changes.length).toBe(2);
  });

  it("keeps whole removed subtrees", () => {
    const m = one(`<Sequence><Fallback><X/><Y/></Fallback><A/></Sequence>`, `<Sequence><A/></Sequence>`);
    expect(shape(m)).toEqual({ Sequence: [{ "Fallback:removed": ["X:removed", "Y:removed"] }, "A"] });
  });

  it("leaves a marker where a node moved away from", () => {
    const m = one(
      `<Sequence><Fallback name="f"><A name="a"/><B name="b"/></Fallback><C name="c"/></Sequence>`,
      `<Sequence><Fallback name="f"><B name="b"/></Fallback><C name="c"/><A name="a"/></Sequence>`,
    );
    expect(shape(m)).toEqual({ Sequence: [{ f: ["a:moved-away", "b"] }, "c", "a:moved"] });
    const marker = [...m.marks].find(([, k]) => k.kind === "moved-away")!;
    const moved = [...m.marks].find(([, k]) => k.kind === "moved")!;
    expect(marker[1].partner).toBe(moved[0]);
    expect(moved[1].partner).toBe(marker[0]);
  });

  it("reports wrapping as an added parent, not a move", () => {
    const m = one(`<Sequence><A name="a"/><B name="b"/></Sequence>`, `<Sequence><Retry num_attempts="3"><A name="a"/></Retry><B name="b"/></Sequence>`);
    expect(shape(m)).toEqual({ Sequence: [{ "Retry:added": ["a(wrapped)"] }, "b"] });
    expect(m.changes.length).toBe(1);
  });

  it("reports unwrapping as a removed parent, not a move", () => {
    const m = one(`<Sequence><Retry num_attempts="3"><A name="a"/></Retry><B name="b"/></Sequence>`, `<Sequence><A name="a"/><B name="b"/></Sequence>`);
    expect(shape(m)).toEqual({ Sequence: ["Retry:removed", "a(unwrapped)", "b"] });
  });

  it("shows edited attributes first, with their old values", () => {
    const m = one(`<Sequence><Go goal="a" speed="1" name="go"/></Sequence>`, `<Sequence><Go goal="b" speed="1" mode="x" name="go"/></Sequence>`);
    const [uid, mark] = [...m.marks].find(([, k]) => k.kind === "changed")!;
    const node = m.def.root!.children.find((c) => c.uid === uid)!;
    expect(diffLines(node, mark)).toEqual([
      { key: "goal", value: "b", old: "a", change: "changed" },
      { key: "mode", value: "x", change: "added" },
      { key: "speed", value: "1" },
    ]);
  });

  it("flags SubTrees whose tree changed", () => {
    const all = merge(
      `<BehaviorTree ID="Main"><Sequence><SubTree ID="Dock"/><SubTree ID="Same"/></Sequence></BehaviorTree><BehaviorTree ID="Dock"><A/></BehaviorTree><BehaviorTree ID="Same"><A/></BehaviorTree>`,
      `<BehaviorTree ID="Main"><Sequence><SubTree ID="Dock"/><SubTree ID="Same"/></Sequence></BehaviorTree><BehaviorTree ID="Dock"><B/></BehaviorTree><BehaviorTree ID="Same"><A/></BehaviorTree>`,
    );
    const flagged = [...all.Main.marks.values()].filter((m) => m.innerChange).map((m) => m.newNode!.attrs.ID);
    expect(flagged).toEqual(["Dock"]);
    expect(all.Main.changes.length).toBe(1);
    expect(all.Same.changes).toEqual([]);
  });

  it("draws a deleted tree as all removed", () => {
    const all = merge(`<BehaviorTree ID="Gone"><Sequence><A/></Sequence></BehaviorTree>`, ``);
    expect(shape(all.Gone)).toEqual({ "Sequence:removed": ["A:removed"] });
  });
});
