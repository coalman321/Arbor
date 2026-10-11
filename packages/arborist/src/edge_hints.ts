// Plain-language descriptions of what each parent/child connection means, for people who don't
// know behavior trees (yet). `label` goes on the edge, `help` is the hover text.

import type { BTNode } from "./model.ts";

export interface EdgeHint {
  label: string;
  help: string;
}

/** "{battery}" -> "battery", so blackboard references read like words. */
function plain(value: string | undefined): string {
  if (value === undefined || value === "") return "?";
  const ref = /^\{([^{}]+)\}$/.exec(value.trim());
  return ref ? ref[1] : value;
}

function times(value: string | undefined): string | null {
  const n = Number(value);
  if (value === undefined || Number.isNaN(n)) return null;
  return n < 0 ? "forever" : n === 1 ? "once" : `${n} times`;
}

function duration(msec: string | undefined): string {
  const n = Number(msec);
  if (msec === undefined || Number.isNaN(n)) return plain(msec);
  if (n >= 60000) return `${+(n / 60000).toFixed(1)} min`;
  if (n >= 1000) return `${+(n / 1000).toFixed(1)} s`;
  return `${n} ms`;
}

/** What a decorator does to its child. Shown on its edge, or in its frame header. */
export function decoratorHint(node: BTNode): EdgeHint | null {
  const a = node.attrs;
  switch (node.type) {
    case "Inverter":
      return { label: "flip the answer", help: "If the step below works, this says it failed, and the other way around." };
    case "ForceSuccess":
      return { label: "always say it worked", help: "Whatever happens below, this reports success." };
    case "ForceFailure":
      return { label: "always say it failed", help: "Whatever happens below, this reports failure." };
    case "RetryUntilSuccessful": {
      const n = times(a.num_attempts);
      return {
        label: n === "forever" ? "keep trying" : `try up to ${n ?? plain(a.num_attempts) + " times"}`,
        help: "If the step below fails, try it again, until it works or there are no tries left.",
      };
    }
    case "Repeat": {
      const n = times(a.num_cycles);
      return { label: n === "forever" ? "repeat forever" : `do it ${n ?? plain(a.num_cycles) + " times"}`, help: "Do the step below again and again. Stop if it fails." };
    }
    case "KeepRunningUntilFailure":
      return { label: "repeat until it fails", help: "Keep doing the step below for as long as it works." };
    case "Timeout":
      return { label: `stop after ${duration(a.msec)}`, help: "If the step below takes too long, stop it and count it as failed." };
    case "Delay":
      return { label: `wait ${duration(a.delay_msec)} first`, help: "Wait a little before starting the step below." };
    case "RunOnce":
      return { label: "only the first time", help: "Do the step below once. After that, skip it." };
    case "Precondition":
      return { label: `only if ${a.if || "?"}`, help: "Only do the step below when this is true." };
    case "SkipUnlessUpdated":
      return { label: `only when ${plain(a.entry)} changes`, help: "Skip the step below unless this value has changed." };
    case "WaitValueUpdate":
      return { label: `wait for ${plain(a.entry)} to change`, help: "Wait until this value changes, then do the step below." };
    case "SubTree":
      return { label: "runs this tree", help: `Everything below is the tree "${a.ID}", used here like one step.` };
    default:
      if (node.type.startsWith("Loop")) {
        return { label: `for each in ${plain(a.queue)}`, help: "Do the step below once for every item in the list." };
      }
      return null;
  }
}

/**
 * The description of the edge from `parent` to its child at `index` (an index into
 * parent.children), or null if there's nothing helpful to say.
 */
export function edgeHint(parent: BTNode, index: number): EdgeHint | null {
  const t = parent.type;
  const n = parent.children.length;
  if (t === "IfThenElse") {
    return index === 1
      ? { label: "if yes", help: "Done when the question in the box above is true." }
      : { label: "if no", help: "Done when the question in the box above is false." };
  }
  if (t === "WhileDoElse") {
    return index === 1
      ? { label: "while yes", help: "Keeps going while the question in the box above stays true." }
      : { label: "if no", help: "Done when the question in the box above is false." };
  }
  if (/Sequence/.test(t)) {
    const help =
      t === "ReactiveSequence"
        ? "Do the steps in order. Earlier steps are checked again every time, and if one fails, everything stops."
        : t === "SequenceWithMemory"
          ? "Do the steps in order. If a step fails, stop, and next time start again from that step."
          : "Do the steps in order, one after another. If a step fails, stop.";
    return { label: `step ${index + 1}`, help };
  }
  if (/Fallback/.test(t)) {
    const help =
      t === "ReactiveFallback"
        ? "Try each option in order until one works. Earlier options are tried again every time."
        : "Try each option in order until one works.";
    return { label: index === 0 ? "try this first" : "if not, try", help };
  }
  if (t.startsWith("Parallel")) {
    return { label: "at the same time", help: "All of these happen together." };
  }
  if (/^Switch\d$/.test(t)) {
    if (index === n - 1) return { label: "otherwise", help: "Done when none of the other choices match." };
    return {
      label: `if ${plain(parent.attrs.variable)} is ${plain(parent.attrs[`case_${index + 1}`])}`,
      help: "Pick the branch whose value matches.",
    };
  }
  if (t === "TryCatch") {
    if (index === n - 1 && n > 1) return { label: "if it goes wrong", help: "Done when one of the steps before it fails." };
    return { label: `step ${index + 1}`, help: "Do the steps in order. If one fails, do the last one instead." };
  }
  return decoratorHint(parent);
}
