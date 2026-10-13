import { describe, expect, it } from "vitest";
import { literalProblem } from "../src/port_types.ts";
import type { EnumModel } from "../src/model.ts";

const enums = new Map<string, EnumModel>([["Mode", { type: "Mode", values: [{ name: "SLOW", value: 0 }, { name: "FAST", value: 1 }] }]]);
const check = (type: string | undefined, literal: string) => literalProblem(type, literal, enums);

describe("literalProblem", () => {
  it("checks spec enums by name or integer", () => {
    expect(check("Mode", "FAST")).toBeUndefined();
    expect(check("Mode", "1")).toBeUndefined();
    expect(check("Mode", "TURBO")).toBe("not a Mode value");
    expect(check("Mode", "5")).toBe("not a Mode value");
  });

  it("checks integers, including their range", () => {
    expect(check("int", "-42")).toBeUndefined();
    expect(check("int", "2147483647")).toBeUndefined();
    expect(check("int", "2147483648")).toBe("out of range for int");
    expect(check("unsigned int", "-1")).toBe("out of range for unsigned int");
    expect(check("uint8_t", "255")).toBeUndefined();
    expect(check("uint8_t", "256")).toBe("out of range for uint8_t");
    expect(check("long", "9223372036854775807")).toBeUndefined();
    expect(check("int", "1.5")).toBe("not an integer");
    expect(check("int", "abc")).toBe("not an integer");
  });

  it("checks floats", () => {
    for (const ok of ["0", "-1.5", ".5", "3.", "1e-3", "+2.5E10", "inf", "-nan"]) expect(check("double", ok)).toBeUndefined();
    expect(check("double", "1.2.3")).toBe("not a number");
    expect(check("float", "fast")).toBe("not a number");
  });

  it("checks bool and NodeStatus the way BT.CPP reads them", () => {
    for (const ok of ["true", "False", "TRUE", "1", "0"]) expect(check("bool", ok)).toBeUndefined();
    expect(check("bool", "yes")).toBe("not true or false");
    expect(check("BT::NodeStatus", "SUCCESS")).toBeUndefined();
    expect(check("BT::NodeStatus", "OK")).toBe("not a BT::NodeStatus value");
  });

  it("accepts anything for strings, unknown types and blackboard entries", () => {
    expect(check("std::string", "anything at all")).toBeUndefined();
    expect(check("Pose2D", "1;2;3")).toBeUndefined();
    expect(check(undefined, "x")).toBeUndefined();
    expect(check("int", "{count}")).toBeUndefined();
  });
});
