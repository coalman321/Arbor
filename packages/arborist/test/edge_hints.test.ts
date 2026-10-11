import { describe, expect, it } from "vitest";
import type { BTNode } from "../src/model.ts";
import { decoratorHint, edgeHint } from "../src/edge_hints.ts";

const n = (type: string, attrs: Record<string, string> = {}, children = 0): BTNode => ({
  uid: type,
  type,
  attrs,
  children: Array.from({ length: children }, (_, i) => ({ uid: `c${i}`, type: "AlwaysSuccess", attrs: {}, children: [] })),
});
const labels = (parent: BTNode) => parent.children.map((_, i) => edgeHint(parent, i)?.label);

describe("edge hints", () => {
  it("describes controls child by child", () => {
    expect(labels(n("Sequence", {}, 3))).toEqual(["step 1", "step 2", "step 3"]);
    expect(labels(n("Fallback", {}, 3))).toEqual(["try this first", "if not, try", "if not, try"]);
    expect(labels(n("Parallel", {}, 2))).toEqual(["at the same time", "at the same time"]);
    expect(labels(n("IfThenElse", {}, 3)).slice(1)).toEqual(["if yes", "if no"]);
    expect(labels(n("Switch2", { variable: "{mode}", case_1: "dock", case_2: "work" }, 3))).toEqual([
      "if mode is dock",
      "if mode is work",
      "otherwise",
    ]);
    expect(labels(n("TryCatch", {}, 3))).toEqual(["step 1", "step 2", "if it goes wrong"]);
    expect(edgeHint(n("ReactiveSequence", {}, 2), 0)?.help).toMatch(/checked again/);
  });

  it("describes decorators with their port values in friendly units", () => {
    expect(decoratorHint(n("RetryUntilSuccessful", { num_attempts: "3" }))?.label).toBe("try up to 3 times");
    expect(decoratorHint(n("RetryUntilSuccessful", { num_attempts: "-1" }))?.label).toBe("keep trying");
    expect(decoratorHint(n("Repeat", { num_cycles: "1" }))?.label).toBe("do it once");
    expect(decoratorHint(n("Timeout", { msec: "1500" }))?.label).toBe("stop after 1.5 s");
    expect(decoratorHint(n("Delay", { delay_msec: "250" }))?.label).toBe("wait 250 ms first");
    expect(decoratorHint(n("Precondition", { if: "battery > 20" }))?.label).toBe("only if battery > 20");
    expect(decoratorHint(n("SkipUnlessUpdated", { entry: "{goal}" }))?.label).toBe("only when goal changes");
    expect(decoratorHint(n("Inverter"))?.label).toBe("flip the answer");
    expect(decoratorHint(n("MoveTo"))).toBeNull();
  });
});
