import { describe, expect, it } from "vitest";
import { parseBtlog, writeBtlog } from "../src/shared/btlog.ts";
import { seek, startReplay } from "../src/web/replay.ts";
import { statusClass } from "@coalman321/arborist";
import { useStore } from "../src/web/store.ts";

const XML = `<root BTCPP_format="4"><BehaviorTree ID="T" _fullpath=""><Sequence name="s" _uid="1"><AlwaysSuccess name="a" _uid="2"/><Wait name="w" _uid="3"/></Sequence></BehaviorTree></root>`;

// Two runs of the tree. Run 1: "a" succeeds, "w" runs, the tree succeeds and BT.CPP resets every
// node to IDLE. Run 2 starts at t=100 and gets halted after "a".
const LOG = parseBtlog(
  writeBtlog(XML, 0, [
    { t: 0, uid: 1, status: "RUNNING" },
    { t: 1, uid: 2, status: "SUCCESS" },
    { t: 1, uid: 3, status: "RUNNING" },
    { t: 50, uid: 3, status: "SUCCESS" },
    { t: 50, uid: 2, status: "IDLE" },
    { t: 50, uid: 3, status: "IDLE" },
    { t: 50, uid: 1, status: "SUCCESS" },
    { t: 50, uid: 1, status: "IDLE" },
    { t: 100, uid: 1, status: "RUNNING" },
    { t: 101, uid: 2, status: "SUCCESS" },
    { t: 101, uid: 3, status: "RUNNING" },
    { t: 120, uid: 3, status: "IDLE" },
    { t: 120, uid: 2, status: "IDLE" },
    { t: 120, uid: 1, status: "IDLE" },
  ]),
);

const classes = () => {
  const by = useStore.getState().live.statusByUid;
  return [1, 2, 3].map((uid) => statusClass(by[uid]));
};

describe("replaying a log", () => {
  it("keeps a finished run's results solid until the next run starts", () => {
    // No trees loaded, so nothing maps and playback doesn't start by itself.
    useStore.setState({ trees: {}, toast: null, root: "/p" });
    startReplay("t.btlog", LOG);
    seek(10);
    expect(classes()).toEqual(["is-running", "is-success", "is-running"]);
    // Between runs: everything is IDLE, but shows how the run ended rather than fading at once.
    seek(70);
    expect(classes()).toEqual(["is-success", "is-success", "is-success"]);
    // The second run starts: the first run's results fade, except what has run again.
    seek(110);
    expect(classes()).toEqual(["is-running", "is-success", "is-running"]);
    // Halted while RUNNING: that's not a result, so it fades. "a" did finish in this run.
    seek(130);
    expect(classes()).toEqual(["was-running", "is-success", "was-running"]);
  });

  it("closes when another project is opened", () => {
    useStore.setState({ root: "/p" });
    startReplay("t.btlog", LOG);
    expect(useStore.getState().replay).not.toBeNull();
    useStore.setState({ root: "/q" });
    expect(useStore.getState().replay).toBeNull();
    expect(useStore.getState().live.state).toBe("idle");
  });
});
