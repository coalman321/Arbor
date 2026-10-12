// Reads (and, for tests and recordings, writes) BehaviorTree.CPP's FileLogger2 ".btlog" files, the
// format Groot2 replays. Layout, from bt_file_logger_v2.cpp (all little-endian):
//
//   "BTCPP4-FileLogger2"   18 bytes of ASCII
//   protocol               1 byte (1)
//   xml length             int32
//   xml                    WriteTreeToXML(tree, add_metadata=true, ...): one <BehaviorTree> per
//                          tree instance, every node with a _uid, SubTree nodes with the _fullpath
//                          of the instance they run
//   start time             int64, microseconds since the Unix epoch
//   transitions            9 bytes each: 6-byte time since start (us), uint16 node uid, uint8 status

import { XMLParser } from "fast-xml-parser";
import type { NodeStatus, RuntimeNode } from "@coalman321/arborist";

const MAGIC = "BTCPP4-FileLogger2";
const HEADER = MAGIC.length + 1 + 4;
const RECORD = 9;

/** BT::NodeStatus values, by their number in the file. */
export const STATUS_BY_CODE: readonly NodeStatus[] = ["IDLE", "RUNNING", "SUCCESS", "FAILURE", "SKIPPED"];

export interface BtLog {
  /** The tree as the robot loaded it. */
  xml: string;
  /** Wall clock at the start of the log, ms since the Unix epoch. */
  startMs: number;
  /** ID of the main tree (the first <BehaviorTree>). */
  treeId: string;
  /** Every node, depth-first pre-order with SubTrees expanded, as in a btlive "tree" message. */
  nodes: RuntimeNode[];
  /** Transitions, oldest first: time since the first one (ms), node uid, status code (STATUS_BY_CODE). */
  times: Float64Array;
  uids: Uint16Array;
  statuses: Uint8Array;
  /** Bytes at the end that didn't make a whole record (the logger was cut off mid-write). */
  truncated: number;
}

export class BtLogError extends Error {}

type XNode = Record<string, unknown> & { ":@"?: Record<string, string> };
const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: "", parseAttributeValue: false });
const tagOf = (x: XNode) => Object.keys(x).find((k) => k !== ":@") ?? "";
const kidsOf = (x: XNode) => ((x[tagOf(x)] as XNode[]) ?? []).filter((c) => !tagOf(c).startsWith("#") && !tagOf(c).startsWith("?"));

/** Rebuilds the runtime node list from the logged XML. */
export function nodesFromLoggedXml(xml: string): { treeId: string; nodes: RuntimeNode[] } {
  let doc: XNode[];
  try {
    doc = parser.parse(xml) as XNode[];
  } catch (e) {
    throw new BtLogError(`The tree XML in the log is invalid: ${(e as Error).message}`);
  }
  const root = doc.find((x) => tagOf(x) === "root");
  const instances = root ? kidsOf(root).filter((x) => tagOf(x) === "BehaviorTree") : [];
  if (!instances.length) throw new BtLogError("The log has no <BehaviorTree> in it");
  // Instances by _fullpath: how a SubTree node finds the tree instance it runs.
  const byPath = new Map(instances.map((t) => [t[":@"]?._fullpath ?? "", t]));
  const nodes: RuntimeNode[] = [];
  const visit = (el: XNode, parent: number | null, depth: number) => {
    const a = el[":@"] ?? {};
    const uid = Number(a._uid);
    if (!Number.isInteger(uid)) throw new BtLogError(`Node <${tagOf(el)}> in the log has no _uid`);
    const type = tagOf(el);
    const node: RuntimeNode = { uid, parent, type, name: type === "SubTree" ? (a.ID ?? type) : (a.name ?? type) };
    if (a._fullpath) node.path = a._fullpath;
    nodes.push(node);
    if (type === "SubTree") {
      node.subtree = a.ID;
      node.category = "SubTree";
      const inst = byPath.get(a._fullpath ?? "");
      const first = inst ? kidsOf(inst)[0] : undefined;
      if (first && depth < 64) visit(first, uid, depth + 1);
      return;
    }
    for (const c of kidsOf(el)) visit(c, uid, depth);
  };
  const main = kidsOf(instances[0])[0];
  if (!main) throw new BtLogError("The main tree in the log is empty");
  visit(main, null, 0);
  return { treeId: instances[0][":@"]?.ID ?? "MainTree", nodes };
}

export function parseBtlog(data: ArrayBuffer | Uint8Array): BtLog {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = new TextDecoder().decode(bytes.subarray(0, MAGIC.length));
  if (magic !== MAGIC) throw new BtLogError("Not a BehaviorTree.CPP log (.btlog written by BT::FileLogger2)");
  if (bytes[MAGIC.length] !== 1) throw new BtLogError(`Unsupported .btlog protocol ${bytes[MAGIC.length]}`);
  const xmlLen = view.getInt32(MAGIC.length + 1, true);
  if (xmlLen <= 0 || HEADER + xmlLen + 8 > bytes.length) throw new BtLogError("The log is cut off before its tree");
  const xml = new TextDecoder().decode(bytes.subarray(HEADER, HEADER + xmlLen));
  const startUs = Number(view.getBigInt64(HEADER + xmlLen, true));
  const body = HEADER + xmlLen + 8;
  const count = Math.floor((bytes.length - body) / RECORD);

  const times = new Float64Array(count);
  const uids = new Uint16Array(count);
  const statuses = new Uint8Array(count);
  // Times are 48-bit microseconds since the logger started. BT.CPP 4.9 subtracts a system_clock
  // start from steady_clock node timestamps, so they're offset by an arbitrary (wrapped) amount; the
  // differences between them are right modulo 2^48. Measure from the first transition instead.
  const WRAP = 2 ** 48;
  const rawAt = (o: number) => view.getUint32(o, true) + view.getUint16(o + 4, true) * 2 ** 32;
  const base = count ? rawAt(body) : 0;
  for (let i = 0, o = body; i < count; i++, o += RECORD) {
    times[i] = (((rawAt(o) - base) % WRAP) + WRAP) % WRAP / 1000;
    uids[i] = view.getUint16(o + 6, true);
    statuses[i] = bytes[o + 8];
  }
  const log: BtLog = { xml, startMs: startUs / 1000, ...nodesFromLoggedXml(xml), times, uids, statuses, truncated: (bytes.length - body) % RECORD };
  // The writer thread writes in order; sort anyway if a log isn't.
  for (let i = 1; i < count; i++) if (times[i] < times[i - 1]) return sortByTime(log);
  return log;
}

function sortByTime(log: BtLog): BtLog {
  const order = Array.from(log.times.keys()).sort((a, b) => log.times[a] - log.times[b]);
  return {
    ...log,
    times: Float64Array.from(order, (i) => log.times[i]),
    uids: Uint16Array.from(order, (i) => log.uids[i]),
    statuses: Uint8Array.from(order, (i) => log.statuses[i]),
  };
}

/** Writes a .btlog. `transitions` times are ms since `startMs`. */
export function writeBtlog(xml: string, startMs: number, transitions: { t: number; uid: number; status: NodeStatus }[]): Uint8Array {
  const xmlBytes = new TextEncoder().encode(xml);
  const out = new Uint8Array(HEADER + xmlBytes.length + 8 + transitions.length * RECORD);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(MAGIC), 0);
  out[MAGIC.length] = 1;
  view.setInt32(MAGIC.length + 1, xmlBytes.length, true);
  out.set(xmlBytes, HEADER);
  view.setBigInt64(HEADER + xmlBytes.length, BigInt(Math.round(startMs * 1000)), true);
  let o = HEADER + xmlBytes.length + 8;
  for (const tr of transitions) {
    const us = Math.round(tr.t * 1000);
    view.setUint32(o, us % 2 ** 32, true);
    view.setUint16(o + 4, Math.floor(us / 2 ** 32), true);
    view.setUint16(o + 6, tr.uid, true);
    out[o + 8] = STATUS_BY_CODE.indexOf(tr.status);
    o += RECORD;
  }
  return out;
}
