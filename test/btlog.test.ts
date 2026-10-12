import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Project } from "../src/server/project.ts";
import { BtLogError, parseBtlog, writeBtlog } from "../src/shared/btlog.ts";
import { mapRuntimeTree } from "@coalman321/arborist";

const DEMO = join(import.meta.dirname, "..", "examples", "demo_project");
// Written by BT::FileLogger2 (BT.CPP 4.9) while the demo project ran at 20 Hz with stub leaf
// nodes for ~8 s.
const FIXTURE = join(import.meta.dirname, "fixtures", "demo_dry_run.btlog");

describe(".btlog", () => {
  it("reads a log written by BehaviorTree.CPP and maps it onto the project", async () => {
    const log = parseBtlog(readFileSync(FIXTURE));
    expect(log.treeId).toBe("MainTree");
    expect(log.truncated).toBe(0);
    expect(log.times.length).toBeGreaterThan(100);
    // BT.CPP 4.9 logs wrapped absolute timestamps; times are re-based on the first transition.
    expect(log.times[0]).toBe(0);
    expect(log.times[log.times.length - 1] / 1000).toBeGreaterThan(5);
    expect(log.times[log.times.length - 1] / 1000).toBeLessThan(15);
    for (let i = 1; i < log.times.length; i++) expect(log.times[i]).toBeGreaterThanOrEqual(log.times[i - 1]);
    // Every logged uid is a node of the logged tree, and SubTrees are expanded in place.
    const uids = new Set(log.nodes.map((n) => n.uid));
    expect([...log.uids].every((u) => uids.has(u))).toBe(true);
    expect(log.nodes.filter((n) => n.type === "SubTree").map((n) => n.subtree)).toEqual(["Recharge", "FetchObject"]);

    const snap = await new Project(DEMO).load();
    const m = mapRuntimeTree(log.treeId, log.nodes, new Map(snap.trees.map((t) => [t.id, t])));
    expect(m.mismatches).toEqual([]);
    expect(m.byRuntimeUid.size).toBe(log.nodes.length);
  });

  it("round-trips through the writer, including 48-bit times and a cut-off last record", () => {
    const xml = `<root BTCPP_format="4"><BehaviorTree ID="T" _fullpath=""><Sequence name="s" _uid="1"><AlwaysSuccess name="a" _uid="2"/></Sequence></BehaviorTree></root>`;
    const bytes = writeBtlog(xml, 1_700_000_000_000, [
      { t: 0, uid: 1, status: "RUNNING" },
      { t: 5, uid: 2, status: "SUCCESS" },
      { t: 2 ** 33 / 1000, uid: 1, status: "SUCCESS" },
    ]);
    const log = parseBtlog(new Uint8Array([...bytes, 1, 2, 3]));
    expect(log.startMs).toBe(1_700_000_000_000);
    expect(log.nodes).toEqual([
      { uid: 1, parent: null, type: "Sequence", name: "s" },
      { uid: 2, parent: 1, type: "AlwaysSuccess", name: "a" },
    ]);
    expect([...log.times]).toEqual([0, 5, 2 ** 33 / 1000]);
    expect([...log.statuses]).toEqual([1, 2, 2]);
    expect(log.truncated).toBe(3);
  });

  it("rejects files that aren't .btlog", () => {
    expect(() => parseBtlog(new TextEncoder().encode("<root/>"))).toThrow(BtLogError);
    const bad = writeBtlog("<root/>", 0, []);
    expect(() => parseBtlog(bad)).toThrow(/no <BehaviorTree>/);
  });
});
