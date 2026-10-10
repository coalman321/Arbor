// Nodes BehaviorTree.CPP 4.9 registers in every BehaviorTreeFactory. They're never written to the
// spec file, so the editor carries its own copy. If the spec file declares a node with the same ID
// (e.g. it was exported with writeTreeNodesModelXML(factory, true)), the spec wins.
//
// Checked against BT::writeTreeNodesModelXML(BT::BehaviorTreeFactory(), true) from 4.9.0: same IDs,
// categories, port names, directions and defaults (SequenceStar, a deprecated alias, is left out).

import type { NodeModel, PortModel } from "./model.ts";

const input = (name: string, type: string, description?: string, def?: string): PortModel => ({
  name,
  direction: "input",
  type,
  description,
  ...(def !== undefined ? { default: def } : {}),
});
const output = (name: string, type: string, description?: string): PortModel => ({
  name,
  direction: "output",
  type,
  description,
});
const inout = (name: string, type: string, description?: string): PortModel => ({
  name,
  direction: "inout",
  type,
  description,
});

function m(id: string, category: NodeModel["category"], description: string, ports: PortModel[] = []): NodeModel {
  return { id, category, description, ports, source: "builtin" };
}

function switchNode(n: number): NodeModel {
  const ports = [input("variable", "std::string", "Value compared against each case")];
  for (let i = 1; i <= n; i++) ports.push(input(`case_${i}`, "std::string", `Value that selects child ${i}`));
  return m(
    `Switch${n}`,
    "Control",
    `Ticks the child whose case_N equals 'variable'; the last (${n + 1}th) child is the default.`,
    ports,
  );
}

function loopNode(suffix: string, cppType: string): NodeModel {
  return m(`Loop${suffix}`, "Decorator", `Pops values from a queue into 'value' and ticks the child once per value.`, [
    inout("queue", "BT::AnyTypeAllowed", "Queue of values to iterate, or a ';'-separated list"),
    input("if_empty", "BT::NodeStatus", "Status to return if queue is empty: SUCCESS, FAILURE, SKIPPED", "SUCCESS"),
    output("value", cppType, "Current value"),
  ]);
}

export const BUILTIN_MODELS: readonly NodeModel[] = [
  // Controls
  m("Sequence", "Control", "Ticks children in order until one fails. Restarts from the first child after a failure."),
  m("SequenceWithMemory", "Control", "Like Sequence, but a RUNNING/FAILED child is resumed instead of restarting from the first."),
  m("ReactiveSequence", "Control", "Re-ticks all previous children every tick; a child that turns FAILURE halts the running one."),
  m("AsyncSequence", "Control", "Sequence that returns RUNNING between children, yielding to the tree after each one."),
  m("Fallback", "Control", "Ticks children in order until one succeeds."),
  m("ReactiveFallback", "Control", "Re-ticks all previous children every tick; a child that turns SUCCESS halts the running one."),
  m("AsyncFallback", "Control", "Fallback that returns RUNNING between children."),
  m("Parallel", "Control", "Ticks all children concurrently.", [
    input("success_count", "int", "Successes needed to return SUCCESS (-1 = all)", "-1"),
    input("failure_count", "int", "Failures needed to return FAILURE (-1 = all)", "1"),
  ]),
  m("ParallelAll", "Control", "Ticks all children until all complete.", [
    input("max_failures", "int", "Failures above which the node returns FAILURE (-1 = all)", "1"),
  ]),
  m("IfThenElse", "Control", "Child 1 is the condition; ticks child 2 on SUCCESS, child 3 (if present) on FAILURE."),
  m("WhileDoElse", "Control", "Reactive IfThenElse: the condition is re-evaluated every tick."),
  m("TryCatch", "Control", "Ticks the first N-1 children as a Sequence; if one fails, ticks the last child (catch) and returns FAILURE.", [
    input("catch_on_halt", "bool", "If true, execute the catch child when the node is halted during the try-block", "false"),
  ]),
  switchNode(2),
  switchNode(3),
  switchNode(4),
  switchNode(5),
  switchNode(6),

  // Decorators
  m("Inverter", "Decorator", "Swaps SUCCESS and FAILURE."),
  m("ForceSuccess", "Decorator", "Returns SUCCESS when the child completes."),
  m("ForceFailure", "Decorator", "Returns FAILURE when the child completes."),
  m("KeepRunningUntilFailure", "Decorator", "Returns RUNNING while the child succeeds, FAILURE when it fails."),
  m("Repeat", "Decorator", "Ticks the child until it has succeeded N times; FAILURE if it fails.", [
    input("num_cycles", "int", "Repetitions (-1 = forever)"),
  ]),
  m("RetryUntilSuccessful", "Decorator", "Ticks the child until it succeeds, up to N attempts.", [
    input("num_attempts", "int", "Attempts (-1 = forever)"),
  ]),
  m("Timeout", "Decorator", "Halts the child and returns FAILURE if it runs longer than msec.", [
    input("msec", "unsigned", "Timeout in milliseconds"),
  ]),
  m("Delay", "Decorator", "Waits delay_msec before ticking the child.", [
    input("delay_msec", "unsigned", "Delay in milliseconds"),
  ]),
  m("RunOnce", "Decorator", "Ticks the child once; later ticks return its first result or SKIPPED.", [
    input("then_skip", "bool", "If true, return SKIPPED after the first run instead of the cached status", "true"),
  ]),
  m("Precondition", "Decorator", "Ticks the child only if the script 'if' is true; otherwise returns 'else'.", [
    input("if", "std::string", "Condition script"),
    input("else", "BT::NodeStatus", "Status returned when the condition is false", "FAILURE"),
  ]),
  m("SkipUnlessUpdated", "Decorator", "Skips the child unless the blackboard entry changed since the last tick.", [
    input("entry", "BT::Any", "Blackboard entry to check, e.g. {my_key}"),
  ]),
  m("WaitValueUpdate", "Decorator", "Returns RUNNING until the blackboard entry changes, then ticks the child.", [
    input("entry", "BT::Any", "Blackboard entry to watch, e.g. {my_key}"),
  ]),
  loopNode("Int", "int"),
  loopNode("Double", "double"),
  loopNode("String", "std::string"),
  loopNode("Bool", "bool"),

  // Actions
  m("AlwaysSuccess", "Action", "Returns SUCCESS."),
  m("AlwaysFailure", "Action", "Returns FAILURE."),
  m("Script", "Action", "Executes a script, e.g. counter += 1; target := 'home'", [
    input("code", "std::string", "Script to execute"),
  ]),
  m("SetBlackboard", "Action", "Copies 'value' into the blackboard entry 'output_key'.", [
    input("value", "BT::AnyTypeAllowed", "Value to write (literal or {other_key})"),
    inout("output_key", "BT::AnyTypeAllowed", "Destination entry name"),
  ]),
  m("UnsetBlackboard", "Action", "Removes an entry from the blackboard.", [input("key", "std::string", "Entry to remove")]),
  m("WasEntryUpdated", "Action", "SUCCESS if the blackboard entry changed since the last tick, else FAILURE.", [
    input("entry", "BT::Any", "Blackboard entry to check, e.g. {my_key}"),
  ]),
  m("Sleep", "Action", "Returns RUNNING for msec milliseconds, then SUCCESS.", [
    input("msec", "unsigned", "Sleep duration in milliseconds"),
  ]),

  // Conditions
  m("ScriptCondition", "Condition", "SUCCESS if the script evaluates to true, else FAILURE.", [
    input("code", "std::string", "Boolean script, e.g. battery > 20"),
  ]),
];

/** The generic SubTree node; each tree in the project also gets its own model (see projectModels). */
export const SUBTREE_MODEL: NodeModel = {
  id: "SubTree",
  category: "SubTree",
  description: "Instantiates another tree of the project.",
  ports: [],
  source: "builtin",
};
