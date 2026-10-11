import { describe, expect, it } from "vitest";
import { isNewer } from "../src/desktop/update.ts";

describe("isNewer", () => {
  it("compares each part numerically", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("0.10.0", "0.9.9")).toBe(true);
    expect(isNewer("1.0.0", "0.99.99")).toBe(true);
    expect(isNewer("0.1.1", "0.1.0")).toBe(true);
  });

  it("is false for the same or an older version", () => {
    expect(isNewer("0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("0.1.0", "0.2.0")).toBe(false);
  });

  it("is false for anything that isn't X.Y.Z", () => {
    expect(isNewer("nightly", "0.1.0")).toBe(false);
    expect(isNewer("0.2.0-beta", "0.1.0")).toBe(false);
    expect(isNewer("0.2.0", "dev")).toBe(false);
  });
});
