// Parses BehaviorTree.CPP v4 XML (tree files and TreeNodesModel spec files) into the editor model.

import { XMLParser } from "fast-xml-parser";
import type { BTNode, EnumModel, EnumValue, NodeCategory, NodeModel, PortDirection, PortModel, TreeDef } from "./model.ts";

// preserveOrder keeps children (and attributes) in file order, which matters: child order is
// execution order. Each element comes back as { [tagName]: children[], ":@"?: attrs }.
type XNode = Record<string, unknown> & { ":@"?: Record<string, string> };

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  commentPropName: "#comment",
  processEntities: true,
  htmlEntities: true,
});

function tagOf(x: XNode): string {
  for (const k of Object.keys(x)) if (k !== ":@") return k;
  return "";
}
function childrenOf(x: XNode): XNode[] {
  return (x[tagOf(x)] as XNode[]) ?? [];
}
function attrsOf(x: XNode): Record<string, string> {
  return { ...(x[":@"] ?? {}) };
}
function elementsOf(x: XNode): XNode[] {
  return childrenOf(x).filter((c) => {
    const t = tagOf(c);
    return t !== "#text" && t !== "#comment" && !t.startsWith("?");
  });
}
function textOf(x: XNode): string {
  return childrenOf(x)
    .filter((c) => tagOf(c) === "#text")
    .map((c) => String(c["#text"]))
    .join("")
    .trim();
}

export class XmlError extends Error {}

function parseDocument(xml: string): XNode {
  let doc: XNode[];
  try {
    doc = parser.parse(xml, true) as XNode[];
  } catch (e) {
    throw new XmlError(`Invalid XML: ${(e as Error).message}`);
  }
  // fast-xml-parser is lenient about some malformed input; validate=true above catches the rest.
  const root = doc.find((x) => tagOf(x) === "root");
  if (!root) throw new XmlError("Missing <root> element");
  return root;
}

const PORT_DIRECTIONS: Record<string, PortDirection> = {
  input_port: "input",
  output_port: "output",
  inout_port: "inout",
};

const CATEGORIES = new Set<NodeCategory>(["Action", "Condition", "Control", "Decorator", "SubTree"]);

function parseModelElement(el: XNode, source: NodeModel["source"]): NodeModel | null {
  const category = tagOf(el) as NodeCategory;
  if (!CATEGORIES.has(category)) return null;
  const attrs = attrsOf(el);
  if (!attrs.ID) return null;
  const ports: PortModel[] = [];
  let description: string | undefined;
  let metadata: Record<string, string> | undefined;
  for (const child of elementsOf(el)) {
    const tag = tagOf(child);
    const dir = PORT_DIRECTIONS[tag];
    if (dir) {
      const pa = attrsOf(child);
      if (!pa.name) continue;
      const port: PortModel = { name: pa.name, direction: dir };
      if (pa.type) port.type = pa.type;
      if (pa.default !== undefined) port.default = pa.default;
      const desc = textOf(child) || pa.description;
      if (desc) port.description = desc;
      ports.push(port);
    } else if (tag === "description") {
      description = textOf(child);
    } else if (tag === "MetaFields") {
      metadata = {};
      for (const f of elementsOf(child)) metadata[tagOf(f)] = textOf(f);
    }
  }
  description ??= attrs.description ?? metadata?.description;
  const model: NodeModel = { id: attrs.ID, category, ports, source };
  if (description) model.description = description;
  if (metadata && Object.keys(metadata).length) model.metadata = metadata;
  return model;
}

function parseTreeNodesModel(root: XNode, source: NodeModel["source"]): NodeModel[] {
  const out: NodeModel[] = [];
  for (const el of elementsOf(root)) {
    if (tagOf(el) !== "TreeNodesModel") continue;
    for (const m of elementsOf(el)) {
      const model = parseModelElement(m, source);
      if (model) out.push(model);
    }
  }
  return out;
}

/**
 * Parses the <Enums> section of a spec file:
 *   <Enums><Enum type="SwerveStates"><Value name="IDLE" value="0">description</Value>...</Enum></Enums>
 */
function parseEnums(root: XNode, warnings: string[]): EnumModel[] {
  const out = new Map<string, EnumModel>();
  for (const el of elementsOf(root)) {
    if (tagOf(el) !== "Enums") continue;
    for (const e of elementsOf(el)) {
      if (tagOf(e) !== "Enum") {
        warnings.push(`Unknown element <${tagOf(e)}> in <Enums> was ignored`);
        continue;
      }
      const type = attrsOf(e).type;
      if (!type) {
        warnings.push("<Enum> without a type was ignored");
        continue;
      }
      if (out.has(type)) {
        warnings.push(`Enum "${type}" is defined more than once; the first definition is used`);
        continue;
      }
      const model: EnumModel = { type, values: [] };
      const description = attrsOf(e).description;
      if (description) model.description = description;
      for (const v of elementsOf(e)) {
        const va = attrsOf(v);
        if (tagOf(v) !== "Value" || !va.name) {
          warnings.push(`Enum "${type}": only <Value name="..."> elements are allowed`);
          continue;
        }
        if (model.values.some((x) => x.name === va.name)) {
          warnings.push(`Enum "${type}": value "${va.name}" is listed more than once`);
          continue;
        }
        const value: EnumValue = { name: va.name };
        if (va.value !== undefined) {
          if (/^-?\d+$/.test(va.value.trim())) value.value = Number(va.value);
          else warnings.push(`Enum "${type}": value "${va.name}" has a non-integer value="${va.value}"`);
        }
        const desc = textOf(v);
        if (desc) value.description = desc;
        model.values.push(value);
      }
      if (!model.values.length) warnings.push(`Enum "${type}" has no values`);
      out.set(type, model);
    }
  }
  return [...out.values()];
}

export interface ParsedSpec {
  models: NodeModel[];
  enums: EnumModel[];
  warnings: string[];
}

/**
 * Parses a spec file: a <root> with a <TreeNodesModel>, as written by BT::writeTreeNodesModelXML,
 * and optionally an <Enums> section listing the values of the enum types its ports use.
 */
export function parseSpec(xml: string): ParsedSpec {
  const root = parseDocument(xml);
  const warnings: string[] = [];
  const enums = parseEnums(root, warnings);
  return { models: parseTreeNodesModel(root, "spec"), enums, warnings };
}

/** The node models of a spec file; parseSpec() also returns its enums. */
export function parseSpecFile(xml: string): NodeModel[] {
  return parseTreeNodesModel(parseDocument(xml), "spec");
}

// BT.CPP v3 style <Action ID="Foo"/> is still accepted by v4; normalize it to the compact <Foo/>.
const EXPLICIT_CATEGORY_TAGS = new Set(["Action", "Condition", "Control", "Decorator"]);

export interface ParsedTreeFile {
  mainTree?: string;
  includes: string[];
  trees: TreeDef[];
  /** SubTree models declared in this file's TreeNodesModel for trees defined elsewhere. */
  foreignSubtreeModels: NodeModel[];
  /** Non-SubTree models declared in this file's TreeNodesModel (e.g. Groot2 output). */
  nodeModels: NodeModel[];
  warnings: string[];
}

export function parseTreeFile(xml: string, filePath: string): ParsedTreeFile {
  const root = parseDocument(xml);
  const rootAttrs = attrsOf(root);
  const warnings: string[] = [];
  if (rootAttrs.BTCPP_format && rootAttrs.BTCPP_format !== "4") {
    warnings.push(`BTCPP_format="${rootAttrs.BTCPP_format}"; the editor writes format 4`);
  }

  const models = parseTreeNodesModel(root, "tree");
  const subtreeModels = new Map(models.filter((m) => m.category === "SubTree").map((m) => [m.id, m]));

  const includes: string[] = [];
  const trees: TreeDef[] = [];
  for (const el of elementsOf(root)) {
    const tag = tagOf(el);
    if (tag === "include") {
      const p = attrsOf(el).path;
      if (p) includes.push(p);
    } else if (tag === "BehaviorTree") {
      const attrs = attrsOf(el);
      const id = attrs.ID;
      if (!id) {
        warnings.push("<BehaviorTree> without an ID was ignored");
        continue;
      }
      delete attrs.ID;
      const description = attrs._description;
      delete attrs._description;
      let counter = 0;
      const nextUid = () => `n${++counter}`;
      const kids = elementsOf(el);
      if (kids.length > 1) warnings.push(`Tree "${id}" has ${kids.length} root nodes; only the first is kept`);
      const tree: TreeDef = {
        id,
        file: filePath,
        ports: subtreeModels.get(id)?.ports ?? [],
        attrs,
        root: kids.length ? parseNode(kids[0], nextUid) : null,
      };
      if (description) tree.description = description;
      subtreeModels.delete(id);
      trees.push(tree);
    } else if (tag === "Enums") {
      warnings.push("<Enums> belongs in the node spec; enums in tree files are ignored and dropped on save");
    } else if (tag !== "TreeNodesModel") {
      warnings.push(`Unknown element <${tag}> under <root> will be dropped on save`);
    }
  }
  return {
    mainTree: rootAttrs.main_tree_to_execute,
    includes,
    trees,
    foreignSubtreeModels: [...subtreeModels.values()],
    nodeModels: models.filter((m) => m.category !== "SubTree"),
    warnings,
  };
}

function parseNode(el: XNode, nextUid: () => string): BTNode {
  let type = tagOf(el);
  const attrs = attrsOf(el);
  if (EXPLICIT_CATEGORY_TAGS.has(type) && attrs.ID) {
    type = attrs.ID;
    delete attrs.ID;
  }
  return {
    uid: nextUid(),
    type,
    attrs,
    children: elementsOf(el).map((c) => parseNode(c, nextUid)),
  };
}
