import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Simulator } from "../src/mock/simulator.ts";
import { Project } from "../src/server/project.ts";
import { mapRuntimeTree } from "../src/shared/live_mapping.ts";
import { STATUS_VALUES } from "../src/shared/protocol.ts";
import { projectModels } from "../src/shared/validate.ts";

const DEMO = join(import.meta.dirname, "..", "examples", "demo_project");

describe("mock robot simulator", () => {
  it("reports a tree the editor maps completely, and plausible transitions", async () => {
    const snap = await new Project(DEMO).load();
    const trees = new Map(snap.trees.map((t) => [t.id, t]));
    let seed = 42;
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const sim = new Simulator("MainTree", trees, projectModels(snap.specModels, snap.trees), { successRate: 0.8, random });

    const nodes = sim.runtimeNodes();
    const mapping = mapRuntimeTree("MainTree", nodes, trees);
    expect(mapping.mismatches).toEqual([]);
    expect(mapping.byRuntimeUid.size).toBe(nodes.length);
    expect(nodes.filter((n) => n.subtree).map((n) => n.subtree)).toEqual(["Recharge", "FetchObject"]);

    const uids = new Set(nodes.map((n) => n.uid));
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      sim.tick();
      for (const [t, uid, prev, status] of sim.takeChanges()) {
        expect(uids.has(uid)).toBe(true);
        expect(STATUS_VALUES).toContain(status);
        expect(prev).not.toBe(status);
        expect(t).toBeGreaterThan(0);
        seen.add(status);
      }
    }
    expect(seen).toEqual(new Set(["RUNNING", "SUCCESS", "FAILURE", "IDLE"]));
  });
});
