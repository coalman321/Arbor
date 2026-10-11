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

/** `custom` is a node type's own icon, from `<MetaFields><icon>` in the node spec. */
/** Glyphs for families of builtins matched by prefix (Switch2, Switch3, ..., LoopInt, LoopDouble, ...). */
const BY_PREFIX: Record<string, string> = {
  Switch: "⋮",
  Loop: "⟳",
};

export function iconFor(type: string, category: string, custom?: string): string {
  if (custom) return custom;
  for (const [prefix, icon] of Object.entries(BY_PREFIX)) if (type.startsWith(prefix)) return icon;
  return BY_TYPE[type] ?? BY_CATEGORY[category] ?? "•";
}

/** Short hints for builtins that change how a reactive tree behaves; shown on the node. */
export function flavorOf(type: string): string | null {
  if (type.startsWith("Reactive")) return "reactive";
  if (type === "SequenceWithMemory") return "memory";
  if (type.startsWith("Async")) return "async";
  return null;
}

/** The glyphs the editor itself uses, each named after the node types that show it. "!" marks unknown types, so it isn't offered. */
function builtinChoices(): [icon: string, name: string][] {
  const names = new Map<string, Set<string>>();
  for (const table of [BY_CATEGORY, BY_TYPE, BY_PREFIX])
    for (const [name, icon] of Object.entries(table)) if (icon !== BY_CATEGORY.Unknown) names.set(icon, (names.get(icon) ?? new Set()).add(name));
  return [...names].map(([icon, set]) => {
    const n = [...set];
    return [icon, n.length > 3 ? `${n.slice(0, 3).join(", ")}, …` : n.join(", ")];
  });
}

/** Icons offered for custom node types, grouped for the picker; each has a name for its tooltip. */
export const ICON_CHOICES: { group: string; icons: [icon: string, name: string][] }[] = [
  { group: "Built-in", icons: builtinChoices() },
  {
    group: "Motion",
    icons: [
      ["🚗", "Drive"],
      ["🧭", "Navigate"],
      ["📍", "Location"],
      ["🗺️", "Map"],
      ["🏁", "Finish"],
      ["🏠", "Home"],
      ["🔄", "Rotate"],
      ["🛑", "Stop"],
      ["🧗", "Climb"],
      ["🚀", "Launch"],
    ],
  },
  {
    group: "Sensing",
    icons: [
      ["👁️", "Look"],
      ["📷", "Camera"],
      ["🔍", "Search"],
      ["📡", "Sensor"],
      ["🎯", "Target"],
      ["📏", "Measure"],
      ["🌡️", "Temperature"],
      ["🚦", "Signal"],
    ],
  },
  {
    group: "Manipulation",
    icons: [
      ["🦾", "Arm"],
      ["✋", "Hand"],
      ["🤏", "Grip"],
      ["📦", "Object"],
      ["⚽", "Ball"],
      ["🧹", "Sweep"],
      ["🧲", "Magnet"],
      ["🔧", "Tool"],
      ["⚙️", "Mechanism"],
    ],
  },
  {
    group: "Power",
    icons: [
      ["🔋", "Battery"],
      ["🔌", "Charge"],
      ["⚡", "Power"],
    ],
  },
  {
    group: "Logic & data",
    icons: [
      ["⏱️", "Timer"],
      ["⏳", "Wait"],
      ["🧮", "Compute"],
      ["❓", "Query"],
      ["✅", "Check"],
      ["⚠️", "Warning"],
      ["🔒", "Lock"],
      ["🔓", "Unlock"],
      ["💾", "Save"],
      ["📝", "Log"],
    ],
  },
  {
    group: "Communication",
    icons: [
      ["💬", "Say"],
      ["🔔", "Alert"],
      ["📨", "Send"],
      ["📥", "Receive"],
      ["💡", "Light"],
      ["🔊", "Sound"],
    ],
  },
  {
    group: "Other",
    icons: [
      ["⭐", "Star"],
      ["❤️", "Heart"],
      ["🧪", "Test"],
      ["🐞", "Debug"],
      ["🔥", "Fire"],
      ["❄️", "Freeze"],
    ],
  },
];
