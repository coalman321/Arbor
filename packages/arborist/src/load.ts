// Turns the XML of a set of tree files (and optionally a node spec) into trees and models. Reading
// the files is up to the host: Arbor, for one, reads a project directory or a git revision.

import { type Diagnostic, type EnumModel, type LoadedFile, type NodeModel, type TreeDef } from "./model.ts";
import { projectModels } from "./models.ts";
import { literalProblem } from "./port_types.ts";
import { parseSpec, parseTreeFile } from "./xml_read.ts";

export interface XmlFile {
  /** Path used in diagnostics and TreeDef.file; any naming scheme the host likes. */
  path: string;
  xml: string;
}

export interface LoadInput {
  /** The TreeNodesModel file, e.g. written by BT::writeTreeNodesModelXML(). */
  spec?: XmlFile;
  /** Where the spec is, or would be, for diagnostics when `spec` is missing. Defaults to spec.path. */
  specPath?: string;
  /** Tree files, in the order their trees should be listed. */
  files: XmlFile[];
}

export interface LoadedTrees {
  trees: TreeDef[];
  /** Models from the spec, plus node types only declared in tree files (Groot2 copies them there). */
  specModels: NodeModel[];
  /** Enums from the spec's <Enums> section. */
  specEnums: EnumModel[];
  /** Every model by ID, builtins included: what layoutTree() and the viewer take. */
  models: Map<string, NodeModel>;
  /** One entry per input file, in input order. */
  files: LoadedFile[];
  /** Problems found while loading (unparsable XML, duplicate IDs, ...). */
  diagnostics: Diagnostic[];
}

export function loadTrees(input: LoadInput): LoadedTrees {
  const diagnostics: Diagnostic[] = [];

  let specModels: NodeModel[] = [];
  let specEnums: EnumModel[] = [];
  if (input.spec) {
    const path = input.spec.path;
    try {
      const spec = parseSpec(input.spec.xml);
      specModels = spec.models;
      specEnums = spec.enums;
      for (const w of spec.warnings) diagnostics.push({ severity: "warning", message: w, file: path });
      diagnostics.push(...checkDefaults(specModels, specEnums, path));
    } catch (e) {
      diagnostics.push({ severity: "error", message: (e as Error).message, file: input.spec.path });
    }
  }

  const files: LoadedFile[] = [];
  const trees: TreeDef[] = [];
  const treeOwner = new Map<string, string>();
  const extraModels = new Map<string, NodeModel>();
  for (const { path, xml } of input.files) {
    const file: LoadedFile = { path, includes: [], treeIds: [] };
    files.push(file);
    let parsed;
    try {
      parsed = parseTreeFile(xml, path);
    } catch (e) {
      file.readOnlyReason = (e as Error).message;
      diagnostics.push({ severity: "error", message: (e as Error).message, file: path });
      continue;
    }
    for (const w of parsed.warnings) diagnostics.push({ severity: "warning", message: w, file: path });
    file.mainTree = parsed.mainTree;
    file.includes = parsed.includes;
    for (const t of parsed.trees) {
      const owner = treeOwner.get(t.id);
      if (owner) {
        file.readOnlyReason = `Tree ID "${t.id}" is already defined in ${owner}`;
        diagnostics.push({ severity: "error", message: file.readOnlyReason, file: path, treeId: t.id });
        continue;
      }
      treeOwner.set(t.id, path);
      file.treeIds.push(t.id);
      trees.push(t);
    }
    // Groot2 copies node models into each tree file; use them as a fallback for the spec.
    for (const m of parsed.nodeModels) if (!extraModels.has(m.id)) extraModels.set(m.id, m);
    // A file may also describe the ports of a tree defined in another file.
    for (const m of parsed.foreignSubtreeModels) {
      const t = trees.find((x) => x.id === m.id);
      if (t && t.ports.length === 0) t.ports = m.ports;
    }
  }

  const specIds = new Set(specModels.map((m) => m.id));
  const fallback = [...extraModels.values()].filter((m) => !specIds.has(m.id));
  if (fallback.length) {
    diagnostics.push({
      severity: "info",
      message: `${fallback.length} node type(s) are only declared in tree files (${fallback
        .slice(0, 5)
        .map((m) => m.id)
        .join(", ")}${fallback.length > 5 ? ", ..." : ""}); add them to ${input.specPath ?? input.spec?.path ?? "the node spec"}`,
    });
  }

  const allSpecModels = [...specModels, ...fallback];
  return { trees, specModels: allSpecModels, specEnums, models: projectModels(allSpecModels, trees), files, diagnostics };
}

/** Port defaults in the spec that BT.CPP couldn't read as their port's type. */
function checkDefaults(models: NodeModel[], enums: EnumModel[], file: string): Diagnostic[] {
  const byType = new Map(enums.map((e) => [e.type, e]));
  const out: Diagnostic[] = [];
  for (const m of models) {
    for (const p of m.ports) {
      const problem = p.default ? literalProblem(p.type, p.default, byType) : undefined;
      if (problem) out.push({ severity: "warning", message: `${m.id}: default "${p.default}" of port "${p.name}" is ${problem}`, file });
    }
  }
  return out;
}
