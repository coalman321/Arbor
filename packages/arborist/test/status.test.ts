import { describe, expect, it } from "vitest";
import type { TreeDef } from "../src/model.ts";
import type { RuntimeNode, StatusChange } from "../src/protocol.ts";
import { statusClass } from "../src/status.ts";
import { StatusTracker } from "../src/tracker.ts";

// Seq(n1) -> [A(n2), B(n3)]; the robot numbers them 1, 2, 3.
const TREE: TreeDef = {
  id: "Main",
  file: "main.xml",
  ports: [],
  attrs: {},
  root: {
    uid: "n1",
    type: "Sequence",
    attrs: {},
    children: [
      { uid: "n2", type: "A", attrs: {}, children: [] },
      { uid: "n3", type: "B", attrs: {}, children: [] },
    ],
  },
};
const RUNTIME: RuntimeNode[] = [
  { uid: 1, parent: null, type: "Sequence", name: "Sequence" },
  { uid: 2, parent: 1, type: "A", name: "A" },
  { uid: 3, parent: 1, type: "B", name: "B" },
];

function tracker() {
  const t = new StatusTracker([TREE]);
  t.setRuntimeTree("Main", RUNTIME);
  return t;
}

/** One run: everything succeeds, then BT.CPP resets the tree to IDLE. */
const run = (t0: number): StatusChange[] => [
  [t0, 1, "IDLE", "RUNNING"],
  [t0 + 1, 2, "IDLE", "SUCCESS"],
  [t0 + 2, 3, "IDLE", "SUCCESS"],
  [t0 + 3, 1, "RUNNING", "SUCCESS"],
  [t0 + 4, 2, "SUCCESS", "IDLE"],
  [t0 + 4, 3, "SUCCESS", "IDLE"],
  [t0 + 4, 1, "SUCCESS", "IDLE"],
];

describe("StatusTracker", () => {
  it("maps runtime UIDs onto tree nodes", () => {
    const t = tracker();
    expect(t.mapping?.mismatches).toEqual([]);
    t.applyChanges([[10, 2, "IDLE", "RUNNING"]]);
    expect(t.statuses.statusByPath.n2.status).toBe("RUNNING");
    expect(t.statuses.statusByDef["Main:n2"].status).toBe("RUNNING");
  });

  it("keeps showing a finished run's results until the next run starts", () => {
    const t = tracker();
    t.applyChanges(run(0));
    // Reset to IDLE, but done in this run: still drawn as a result.
    expect(statusClass(t.statuses.statusByPath.n2)).toBe("is-success");
    t.applyChanges([[100, 1, "IDLE", "RUNNING"]]);
    // A new run: the old results fade.
    expect(statusClass(t.statuses.statusByPath.n2)).toBe("was-success");
    expect(statusClass(t.statuses.statusByPath.n1)).toBe("is-running");
  });

  it("replaces statuses rather than mutating them", () => {
    const t = tracker();
    const before = t.statuses;
    t.applyChanges([[10, 2, "IDLE", "RUNNING"]]);
    expect(t.statuses).not.toBe(before);
    expect(before.statusByPath.n2).toBeUndefined();
  });

  it("takes snapshots, and re-pairs nodes when the trees change", () => {
    const t = tracker();
    t.applySnapshot([[3, "FAILURE"]], 50);
    expect(t.statuses.statusByPath.n3).toMatchObject({ status: "FAILURE", t: 50 });
    // B's uid changes in an edit; its status follows it.
    const edited: TreeDef = { ...TREE, root: { ...TREE.root!, children: [TREE.root!.children[0], { ...TREE.root!.children[1], uid: "n9" }] } };
    t.setTrees([edited]);
    expect(t.statuses.statusByPath.n9?.status).toBe("FAILURE");
    expect(t.statuses.statusByPath.n3).toBeUndefined();
  });
});
