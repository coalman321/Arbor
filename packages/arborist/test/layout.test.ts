import { describe, expect, it } from "vitest";
import type { BTNode, TreeDef } from "../src/model.ts";
import { conditionText, layoutTree } from "../src/layout.ts";

const n = (uid: string, type: string, children: BTNode[] = [], attrs: Record<string, string> = {}): BTNode => ({ uid, type, attrs, children });
const tree = (root: BTNode): TreeDef => ({ id: "T", file: "trees/t.xml", ports: [], attrs: {}, root });
const layout = (root: BTNode) => layoutTree(tree(root), {}, { isExpanded: () => false, dir: "TB" });

describe("condition folding", () => {
  it("draws IfThenElse's condition inside it and labels the branches", () => {
    const items = layout(
      n("s", "Sequence", [
        n("ite", "IfThenElse", [
          n("c", "IsBatteryOk", [], { min_percent: "25" }),
          n("a", "MoveTo", [], { location: "dock" }),
          n("b", "Say"),
        ]),
      ]),
    );
    expect(items.map((i) => i.path)).toEqual(["s", "ite", "a", "b"]);
    const ite = items.find((i) => i.path === "ite")!;
    expect(ite.foldedPaths).toEqual(["c"]);
    expect(ite.condition?.keyword).toBe("if");
    expect(conditionText(ite.condition!.part)).toBe("IsBatteryOk(25)");
    expect(items.find((i) => i.path === "a")?.edgeLabel).toBe("then");
    expect(items.find((i) => i.path === "b")?.edgeLabel).toBe("else");
    // The condition row makes the box taller than a plain node.
    expect(ite.h).toBeGreaterThan(items.find((i) => i.path === "s")!.h);
  });

  it("keeps the structure of composite conditions", () => {
    const items = layout(
      n("w", "WhileDoElse", [
        n("seq", "Sequence", [
          n("inv", "Inverter", [n("e", "IsEstopped")]),
          n("f", "Fallback", [n("x", "IsAtLocation", [], { location: "dock" }), n("y", "ScriptCondition", [], { code: "battery > 20" })]),
        ]),
        n("do", "MoveTo"),
      ]),
    );
    const w = items[0];
    expect(w.condition?.keyword).toBe("while");
    expect(conditionText(w.condition!.part)).toBe("¬IsEstopped ∧ (IsAtLocation(dock) ∨ battery > 20)");
    expect(w.foldedPaths).toEqual(["seq", "inv", "e", "f", "x", "y"]);
    expect(items.map((i) => [i.path, i.edgeLabel])).toEqual([
      ["w", undefined],
      ["do", "do"],
    ]);
  });

  it("shows Precondition's script as its condition, not as a port line", () => {
    const [pre] = layout(n("p", "Precondition", [n("k", "Pick")], { if: "attempts <= 3", else: "FAILURE" }));
    expect(pre.condition).toEqual({ keyword: "if", part: { kind: "script", text: "attempts <= 3" } });
    expect(pre.lines.map((l) => l.key)).toEqual(["else"]);
    expect(pre.foldedPaths).toEqual([]);
  });

  it("leaves an IfThenElse without children as an empty box", () => {
    const [ite] = layout(n("i", "IfThenElse"));
    expect(ite.condition).toBeUndefined();
  });
});

describe("decorator frames", () => {
  const isDecorator = (node: BTNode) => ["RetryUntilSuccessful", "Timeout", "Inverter", "Precondition"].includes(node.type);
  const framed = (root: BTNode, dir: "TB" | "LR" = "TB") =>
    layoutTree(tree(root), {}, { isExpanded: () => false, dir, frameDecorator: isDecorator });
  type Rect = { x: number; y: number; w: number; h: number };
  const inside = (a: Rect, b: Rect) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
  const overlap = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

  for (const dir of ["TB", "LR"] as const) {
    it(`surrounds the whole decorated subtree (${dir})`, () => {
      const items = framed(
        n("root", "Sequence", [
          n("retry", "RetryUntilSuccessful", [n("timeout", "Timeout", [n("seq", "Sequence", [n("a", "MoveTo"), n("b", "Pick")])], { msec: "500" })], {
            num_attempts: "3",
          }),
          n("inv", "Inverter", [n("c", "IsBatteryOk")]),
          n("d", "Say"),
        ]),
        dir,
      );
      const at = (p: string) => items.find((i) => i.path === p)!;
      const retry = at("retry");
      const timeout = at("timeout");
      expect(retry.frame?.level).toBe(0);
      expect(timeout.frame?.level).toBe(1);
      // A frame doesn't take a row of its own: the node it wraps sits in the decorator's row.
      expect(at("seq").depth).toBe(retry.depth);
      expect(inside(timeout, retry)).toBe(true);
      for (const p of ["seq", "a", "b"]) expect(inside(at(p), timeout)).toBe(true);
      // The header comes first along the depth axis, ahead of what it wraps.
      const head = dir === "TB" ? timeout.y + timeout.frame!.headerH : timeout.x + timeout.frame!.headerW;
      expect(dir === "TB" ? at("seq").y : at("seq").x).toBeGreaterThan(head);
      expect(inside(at("c"), at("inv"))).toBe(true);
      // Siblings' frames and boxes don't collide.
      expect(overlap(retry, at("inv"))).toBe(false);
      expect(overlap(at("inv"), at("d"))).toBe(false);
      expect(overlap(retry, at("d"))).toBe(false);
    });
  }

  for (const dir of ["TB", "LR"] as const) {
    it(`routes edges above every frame header and aligns headers in a row (${dir})`, () => {
      const items = framed(
        n("root", "Sequence", [
          n("s", "Script"),
          n("retry", "RetryUntilSuccessful", [n("t", "Timeout", [n("f", "Fetch")])]),
          n("inv", "Inverter", [n("c", "IsBatteryOk")]),
          n("d", "Say"),
        ]),
        dir,
      );
      const kids = items.filter((i) => i.parentPath === "root");
      const top = (i: (typeof items)[0]) => (dir === "TB" ? i.y : i.x);
      const bus = kids[0].edgeBus!;
      for (const k of kids) {
        expect(k.edgeBus).toBe(bus);
        expect(top(k)).toBeGreaterThan(bus);
      }
      const root = items[0];
      expect(bus).toBeGreaterThan(top(root) + (dir === "TB" ? root.h : root.w));
      // Outermost frames of the row (Retry, Inverter) share a top line, despite different nesting.
      expect(top(kids.find((k) => k.path === "retry")!)).toBe(top(kids.find((k) => k.path === "inv")!));
    });
  }

  it("leaves decorators without a child, and other nodes, as boxes", () => {
    const items = framed(n("r", "Sequence", [n("i", "Inverter"), n("s", "Say")]));
    expect(items.every((i) => !i.frame)).toBe(true);
  });

  it("keeps Precondition's condition in the frame header", () => {
    const [pre] = framed(n("p", "Precondition", [n("k", "Pick")], { if: "ok", else: "FAILURE" }));
    expect(pre.frame).toBeDefined();
    expect(pre.condition?.part).toEqual({ kind: "script", text: "ok" });
  });
});

describe("expanded SubTree window", () => {
  for (const dir of ["TB", "LR"] as const) {
    it(`locks the subtree's nodes inside a frame naming its tree (${dir})`, () => {
      const sub: TreeDef = { id: "Fetch", file: "trees/fetch.xml", ports: [], attrs: {}, root: n("q", "Sequence", [n("a", "MoveTo"), n("b", "Pick")]) };
      const main = tree(n("r", "Sequence", [n("s", "SubTree", [], { ID: "Fetch" }), n("x", "Say")]));
      const items = layoutTree(main, { Fetch: sub }, { isExpanded: (p) => p === "s", dir });
      const at = (p: string) => items.find((i) => i.path === p)!;
      const win = at("s@window");
      expect(win.window).toEqual({ treeId: "Fetch", file: "trees/fetch.xml" });
      expect(win.parentPath).toBe("s");
      expect(win.readOnly).toBe(true);
      expect(at("s/q").parentPath).toBe("s@window");
      for (const p of ["s/q", "s/a", "s/b"]) {
        const i = at(p);
        expect(i.readOnly).toBe(true);
        expect(i.x >= win.x && i.y >= win.y && i.x + i.w <= win.x + win.w && i.y + i.h <= win.y + win.h).toBe(true);
      }
      // The SubTree node itself stays outside, and editable.
      const s = at("s");
      expect(s.readOnly).toBe(false);
      expect(s.x + s.w <= win.x || s.y + s.h <= win.y).toBe(true);
    });
  }
});
