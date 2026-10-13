// Serializes the editor model back to BehaviorTree.CPP v4 XML. Pure string building so the frontend
// can render the same XML preview the backend writes to disk.

import type { BTNode, EnumModel, NodeModel, PortModel, TreeDef } from "@coalman321/arborist";

const INDENT = "  ";

export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;")
    .replace(/\t/g, "&#9;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function attrString(attrs: Record<string, string | undefined>): string {
  return Object.entries(attrs)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => ` ${k}="${escapeAttr(v as string)}"`)
    .join("");
}

function writeNode(node: BTNode, depth: number, out: string[]) {
  const pad = INDENT.repeat(depth);
  const attrs = attrString(node.attrs);
  if (node.children.length === 0) {
    out.push(`${pad}<${node.type}${attrs}/>`);
    return;
  }
  out.push(`${pad}<${node.type}${attrs}>`);
  for (const c of node.children) writeNode(c, depth + 1, out);
  out.push(`${pad}</${node.type}>`);
}

const PORT_TAG: Record<PortModel["direction"], string> = {
  input: "input_port",
  output: "output_port",
  inout: "inout_port",
};

function writePorts(ports: PortModel[], depth: number, out: string[]) {
  const pad = INDENT.repeat(depth);
  for (const p of ports) {
    const tag = PORT_TAG[p.direction];
    const attrs = attrString({ name: p.name, type: p.type || undefined, default: p.default });
    if (p.description) out.push(`${pad}<${tag}${attrs}>${escapeText(p.description)}</${tag}>`);
    else out.push(`${pad}<${tag}${attrs}/>`);
  }
}

function writeModel(model: { id: string; category: string; ports: PortModel[]; description?: string; metadata?: Record<string, string> }, depth: number, out: string[]) {
  const pad = INDENT.repeat(depth);
  const hasBody = model.ports.length > 0 || model.description || (model.metadata && Object.keys(model.metadata).length);
  if (!hasBody) {
    out.push(`${pad}<${model.category} ID="${escapeAttr(model.id)}"/>`);
    return;
  }
  out.push(`${pad}<${model.category} ID="${escapeAttr(model.id)}">`);
  writePorts(model.ports, depth + 1, out);
  if (model.description) out.push(`${pad}${INDENT}<description>${escapeText(model.description)}</description>`);
  if (model.metadata && Object.keys(model.metadata).length) {
    out.push(`${pad}${INDENT}<MetaFields>`);
    for (const [k, v] of Object.entries(model.metadata)) out.push(`${pad}${INDENT}${INDENT}<${k}>${escapeText(v)}</${k}>`);
    out.push(`${pad}${INDENT}</MetaFields>`);
  }
  out.push(`${pad}</${model.category}>`);
}

export function serializeTree(tree: TreeDef, depth = 1, out: string[] = []): string[] {
  const pad = INDENT.repeat(depth);
  const attrs = attrString({ ID: tree.id, _description: tree.description || undefined, ...tree.attrs });
  if (!tree.root) {
    out.push(`${pad}<BehaviorTree${attrs}/>`);
    return out;
  }
  out.push(`${pad}<BehaviorTree${attrs}>`);
  writeNode(tree.root, depth + 1, out);
  out.push(`${pad}</BehaviorTree>`);
  return out;
}

export interface TreeFileContent {
  mainTree?: string;
  includes: string[];
  trees: TreeDef[];
}

/**
 * A complete tree file. Trees that declare ports get a <SubTree> entry in the file's TreeNodesModel,
 * which is where BT.CPP (and Groot2) look for a subtree's interface.
 */
export function serializeTreeFile(file: TreeFileContent): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>'];
  out.push(`<root${attrString({ BTCPP_format: "4", main_tree_to_execute: file.mainTree || undefined })}>`);
  for (const inc of file.includes) out.push(`${INDENT}<include path="${escapeAttr(inc)}"/>`);
  for (const t of file.trees) serializeTree(t, 1, out);
  const withPorts = file.trees.filter((t) => t.ports.length > 0);
  if (withPorts.length) {
    out.push(`${INDENT}<TreeNodesModel>`);
    for (const t of withPorts) writeModel({ id: t.id, category: "SubTree", ports: t.ports }, 2, out);
    out.push(`${INDENT}</TreeNodesModel>`);
  }
  out.push("</root>", "");
  return out.join("\n");
}

/**
 * The node spec file: a TreeNodesModel in the same format as BT::writeTreeNodesModelXML(), followed
 * by an <Enums> section when there are enums.
 */
export function serializeSpecFile(models: NodeModel[], enums: EnumModel[] = []): string {
  const out: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<root BTCPP_format="4">', `${INDENT}<TreeNodesModel>`];
  for (const model of models) writeModel(model, 2, out);
  out.push(`${INDENT}</TreeNodesModel>`);
  if (enums.length) {
    out.push(`${INDENT}<Enums>`);
    for (const e of enums) writeEnum(e, 2, out);
    out.push(`${INDENT}</Enums>`);
  }
  out.push("</root>", "");
  return out.join("\n");
}

function writeEnum(e: EnumModel, depth: number, out: string[]) {
  const pad = INDENT.repeat(depth);
  const attrs = attrString({ type: e.type, description: e.description });
  if (!e.values.length) {
    out.push(`${pad}<Enum${attrs}/>`);
    return;
  }
  out.push(`${pad}<Enum${attrs}>`);
  for (const v of e.values) {
    const va = attrString({ name: v.name, value: v.value === undefined ? undefined : String(v.value) });
    if (v.description) out.push(`${pad}${INDENT}<Value${va}>${escapeText(v.description)}</Value>`);
    else out.push(`${pad}${INDENT}<Value${va}/>`);
  }
  out.push(`${pad}</Enum>`);
}
