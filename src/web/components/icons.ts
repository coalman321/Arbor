// Glyphs for node types, so a tree can be read at a glance without reading every label. Stick to
// characters common fonts (DejaVu, Segoe UI, SF) have; rarer ones render as empty boxes.

const BY_TYPE: Record<string, string> = {
  Sequence: "→",
  SequenceWithMemory: "→",
  ReactiveSequence: "→",
  AsyncSequence: "→",
  Fallback: "?",
  ReactiveFallback: "?",
  AsyncFallback: "?",
  Parallel: "⇉",
  ParallelAll: "⇉",
  IfThenElse: "⋎",
  WhileDoElse: "⋎",
  Inverter: "¬",
  RetryUntilSuccessful: "↻",
  Repeat: "⟳",
  KeepRunningUntilFailure: "⟳",
  Timeout: "◷",
  Delay: "◴",
  ForceSuccess: "✓",
  ForceFailure: "✗",
  RunOnce: "1",
  Precondition: "⊢",
  Script: "ƒ",
  ScriptCondition: "ƒ",
  SetBlackboard: "≔",
  UnsetBlackboard: "≔",
  Sleep: "◔",
  AlwaysSuccess: "✓",
  AlwaysFailure: "✗",
  SubTree: "▣",
};

const BY_CATEGORY: Record<string, string> = {
  Control: "⋔",
  Decorator: "◇",
  Action: "▶",
  Condition: "◉",
  SubTree: "▣",
  Unknown: "!",
};

export function iconFor(type: string, category: string): string {
  if (type.startsWith("Switch")) return "⋮";
  if (type.startsWith("Loop")) return "⟳";
  return BY_TYPE[type] ?? BY_CATEGORY[category] ?? "•";
}

/** Short hints for builtins that change how a reactive tree behaves; shown on the node. */
export function flavorOf(type: string): string | null {
  if (type.startsWith("Reactive")) return "reactive";
  if (type === "SequenceWithMemory") return "memory";
  if (type.startsWith("Async")) return "async";
  return null;
}
