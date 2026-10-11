import { describe, expect, it } from "vitest";
import { layoutGraph } from "../src/web/git_graph.ts";

const c = (sha: string, ...parents: string[]) => ({ sha, parents });

describe("git graph layout", () => {
  it("draws a straight history in one lane", () => {
    const g = layoutGraph([c("c", "b"), c("b", "a"), c("a")]);
    expect(g.width).toBe(1);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(g.rows[0]).toEqual({ lane: 0, top: [], bottom: [{ from: 0, to: 0, color: 0 }] });
    expect(g.rows[1].top).toEqual([{ from: 0, to: 0, color: 0 }]);
    expect(g.rows[2].bottom).toEqual([]);
  });

  it("opens a lane for a merged branch and closes it where the branch started", () => {
    // m merges x (branch) into b; x and b both come from a.
    const g = layoutGraph([c("m", "b", "x"), c("x", "a"), c("b", "a"), c("a")]);
    expect(g.width).toBe(2);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    // The merge commit sends lines down to both lanes.
    expect(g.rows[0].bottom).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 0, to: 1, color: 1 },
    ]);
    // The branch line carries on beside the main line...
    expect(g.rows[1].bottom).toEqual([
      { from: 0, to: 0, color: 0 },
      { from: 1, to: 1, color: 1 },
    ]);
    // ...and curves back into lane 0 below b, where both head for a.
    expect(g.rows[2].bottom).toEqual([
      { from: 1, to: 0, color: 1 },
      { from: 0, to: 0, color: 0 },
    ]);
    expect(g.rows[3].top).toEqual([{ from: 0, to: 0, color: 0 }]);
  });

  it("starts a new lane for a branch tip nothing points to", () => {
    const g = layoutGraph([c("main", "a"), c("side", "a"), c("a")]);
    expect(g.rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    expect(g.rows[1].top).toEqual([{ from: 0, to: 0, color: 0 }]);
    expect(g.rows[2].top).toEqual([
      { from: 0, to: 0, color: 0 },
    ]);
  });

  it("leaves lines running off the end when parents are beyond the list", () => {
    const g = layoutGraph([c("b", "a")]);
    expect(g.rows[0].bottom).toEqual([{ from: 0, to: 0, color: 0 }]);
  });
});
