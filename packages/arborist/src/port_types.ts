// Checks a port's literal value against its type, the way BT.CPP's convertFromString() would read it:
// the spec's enums, plus the scalar types BT.CPP converts itself (integers, floats, bool, NodeStatus).
// Types it doesn't know (std::string, custom structs, ...) accept anything.

import { findEnumValue, isBlackboardRef, isEnumLiteral, type EnumModel } from "./model.ts";

/** Types with a fixed set of literals that BT.CPP knows without a spec <Enums> entry. */
export const BUILTIN_ENUMS: readonly EnumModel[] = [
  { type: "bool", values: [{ name: "true" }, { name: "false" }] },
  { type: "BT::NodeStatus", values: ["SUCCESS", "FAILURE", "RUNNING", "SKIPPED", "IDLE"].map((name) => ({ name })) },
];

// Integer types by the names BT.CPP's demangle() prints for them (and the <cstdint> aliases): [bits, signed].
const INTEGERS: Record<string, [number, boolean]> = {
  "signed char": [8, true],
  int8_t: [8, true],
  "unsigned char": [8, false],
  uint8_t: [8, false],
  short: [16, true],
  int16_t: [16, true],
  "unsigned short": [16, false],
  uint16_t: [16, false],
  int: [32, true],
  int32_t: [32, true],
  unsigned: [32, false],
  "unsigned int": [32, false],
  uint32_t: [32, false],
  long: [64, true],
  "long long": [64, true],
  int64_t: [64, true],
  "unsigned long": [64, false],
  "unsigned long long": [64, false],
  uint64_t: [64, false],
  size_t: [64, false],
};

const FLOATS = new Set(["float", "double", "long double"]);

// BT.CPP's convertFromString<bool>.
const BOOLS = new Set(["true", "false", "TRUE", "FALSE", "True", "False", "1", "0"]);

/**
 * What is wrong with `literal` as a value of `type`, phrased to follow `"<literal>" is ...`, e.g.
 * "not an integer"; undefined if BT.CPP would accept it, if it's a blackboard entry, or if the type
 * isn't one Arbor can check.
 */
export function literalProblem(type: string | undefined, literal: string, enums: Map<string, EnumModel>): string | undefined {
  if (!type || isBlackboardRef(literal)) return undefined;
  const text = literal.trim();
  const e = enums.get(type);
  if (e) return isEnumLiteral(e, text) ? undefined : `not ${article(e.type)} ${e.type} value`;
  if (type === "bool") return BOOLS.has(text) ? undefined : "not true or false";
  if (type === "BT::NodeStatus") return findEnumValue(BUILTIN_ENUMS[1], text) ? undefined : "not a BT::NodeStatus value";
  const int = INTEGERS[type];
  if (int) {
    if (!/^[-+]?\d+$/.test(text)) return "not an integer";
    const [bits, signed] = int;
    const n = BigInt(text.replace(/^\+/, ""));
    const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
    const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
    return n < min || n > max ? `out of range for ${type}` : undefined;
  }
  if (FLOATS.has(type)) {
    return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text) || /^[-+]?(inf|infinity|nan)$/i.test(text) ? undefined : "not a number";
  }
  return undefined;
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/** The enum a port's type names: the spec's, or bool / BT::NodeStatus. */
export function enumForType(type: string | undefined, enums: Map<string, EnumModel>): EnumModel | undefined {
  if (!type) return undefined;
  return enums.get(type) ?? BUILTIN_ENUMS.find((e) => e.type === type);
}
