// Structural diff between two versions of a behavior tree, e.g. the same tree at two git revisions.
//
// Nodes parsed from different revisions share no identity: parseTreeFile numbers uids in document
// order, so "n5" in one version can be an unrelated node in the other. Matching is therefore purely
// structural, a simplified GumTree (Falleri et al., 2014):
//  1. top-down: identical subtrees are matched, largest first;
//  2. bottom-up: unmatched inner nodes are matched to the node holding most of their matched descendants;
//  3. recovery: unmatched children of matched parents are aligned in order, first by identical
//     subtree, then by name, then by type.
// Comparing parsed models rather than XML text also hides formatting-only changes: attribute order,
// whitespace, and v3 <Action ID="Foo"/> vs. v4 <Foo/>.

import type { BTNode, TreeDef } from "./model.ts";

export interface AttrChange {
  old?: string;
  new?: string;
}

export interface NodeChange {
  oldUid: string;
  newUid: string;
  /** Changed attributes only; a missing side means the attribute was added or removed. */
  attrs: Record<string, AttrChange>;
  /** Set when the type differs, e.g. a Sequence that became a ReactiveSequence. */
  type?: { old: string; new: string };
  /** The node's parent changed. */
  moved: boolean;
  /** Same parent, but its order relative to its siblings changed (child order is execution order). */
  reordered: boolean;
}

export interface TreeDiff {
  /** Matched nodes keyed by new uid, unchanged ones included. */
  matched: Map<string, NodeChange>;
  oldToNew: Map<string, string>;
  newToOld: Map<string, string>;
  /** Uids (new side) of nodes that only exist in the new version. */
  added: Set<string>;
  /** Uids (old side) of nodes that only exist in the old version. */
  removed: Set<string>;
  /** Nodes added, removed, or matched with any change. */
  changes: number;
}

export function isChanged(c: NodeChange): boolean {
  return c.moved || c.reordered || !!c.type || Object.keys(c.attrs).length > 0;
}

/** Hands out one small integer per distinct subtree, so equal subtrees compare in O(1). */
class Interner {
  private ids = new Map<string, number>();
  id(key: string): number {
    let id = this.ids.get(key);
    if (id === undefined) this.ids.set(key, (id = this.ids.size));
    return id;
  }
}

interface Info {
  node: BTNode;
  parent: Info | null;
  children: Info[];
  /** Preorder position; the subtree is pre .. pre + size - 1 in the indexed array. */
  pre: number;
  size: number;
  height: number;
  /** Equal for identical subtrees (type, attributes in any order, children in order). */
  hash: number;
  /** Name-based identity, used in recovery to match nodes whose type changed. */
  label: string;
}

function attrKey(attrs: Record<string, string>): string {
  return JSON.stringify(Object.entries(attrs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function labelOf(n: BTNode): string {
  if (n.attrs.name) return `name:${n.attrs.name}`;
  if (n.type === "SubTree") return `subtree:${n.attrs.ID ?? ""}`;
  return `type:${n.type}`;
}

function index(root: BTNode | null, interner: Interner): Info[] {
  const out: Info[] = [];
  const build = (node: BTNode, parent: Info | null): Info => {
    const info: Info = { node, parent, children: [], pre: out.length, size: 1, height: 1, hash: 0, label: labelOf(node) };
    out.push(info);
    for (const c of node.children) {
      const ci = build(c, info);
      info.children.push(ci);
      info.size += ci.size;
      info.height = Math.max(info.height, ci.height + 1);
    }
    info.hash = interner.id(`${node.type}\0${attrKey(node.attrs)}\0${info.children.map((c) => c.hash).join(",")}`);
    return info;
  };
  if (root) build(root, null);
  return out;
}

function isDescendant(x: Info, of: Info): boolean {
  return x.pre > of.pre && x.pre < of.pre + of.size;
}

/** Longest common subsequence of a and b under `eq`, as index pairs in order. */
function lcs<A, B>(a: A[], b: B[], eq: (x: A, y: B) => boolean): [number, number][] {
  const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) t[i][j] = eq(a[i], b[j]) ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length; ) {
    if (eq(a[i], b[j])) pairs.push([i++, j++]);
    else if (t[i + 1][j] >= t[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/** Indexes (into `xs`) of a longest strictly increasing subsequence. */
function longestIncreasing(xs: number[]): Set<number> {
  const len = xs.map(() => 1);
  const prev = xs.map(() => -1);
  let best = -1;
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < i; j++) if (xs[j] < xs[i] && len[j] + 1 > len[i]) (len[i] = len[j] + 1), (prev[i] = j);
    if (best < 0 || len[i] > len[best]) best = i;
  }
  const keep = new Set<number>();
  for (let i = best; i >= 0; i = prev[i]) keep.add(i);
  return keep;
}

class Matcher {
  readonly fwd = new Map<Info, Info>();
  readonly back = new Map<Info, Info>();

  constructor(
    readonly olds: Info[],
    readonly news: Info[],
  ) {}

  match(o: Info, n: Info) {
    this.fwd.set(o, n);
    this.back.set(n, o);
  }

  /** Matches two identical subtrees node for node. */
  matchSubtree(o: Info, n: Info) {
    this.match(o, n);
    o.children.forEach((c, i) => this.matchSubtree(c, n.children[i]));
  }

  topDown() {
    const group = (infos: Info[]) => {
      const m = new Map<number, Info[]>();
      for (const i of infos) m.get(i.hash)?.push(i) ?? m.set(i.hash, [i]);
      return m;
    };
    const olds = group(this.olds);
    const news = group(this.news);
    // Largest subtrees first, so a match claims its whole subtree before its parts are considered.
    const hashes = [...olds.keys()].filter((h) => news.has(h)).sort((a, b) => olds.get(b)![0].height - olds.get(a)![0].height);
    for (const h of hashes) {
      const os = olds.get(h)!.filter((o) => !this.fwd.has(o));
      const ns = news.get(h)!.filter((n) => !this.back.has(n));
      if (!os.length || !ns.length) continue;
      if (os.length === 1 && ns.length === 1) {
        this.matchSubtree(os[0], ns[0]);
        continue;
      }
      // Several copies: pair the ones whose surroundings agree. Copies of a leaf are left to
      // recovery, which knows the actual parents and so can place them correctly.
      if (os[0].height === 1) continue;
      const pairs: { o: Info; n: Info; score: number }[] = [];
      for (const o of os)
        for (const n of ns) {
          if (!o.parent || !n.parent || o.parent.label !== n.parent.label) continue;
          const index = (x: Info) => x.parent!.children.indexOf(x);
          pairs.push({ o, n, score: (this.fwd.get(o.parent) === n.parent ? 4 : 0) + (index(o) === index(n) ? 1 : 0) });
        }
      pairs.sort((a, b) => b.score - a.score);
      for (const { o, n } of pairs) if (!this.fwd.has(o) && !this.back.has(n)) this.matchSubtree(o, n);
    }
  }

  /** Share of matched descendants of `o` whose match lies under `n`. */
  dice(o: Info, n: Info): number {
    let common = 0;
    for (let i = o.pre + 1; i < o.pre + o.size; i++) {
      const m = this.fwd.get(this.olds[i]);
      if (m && isDescendant(m, n)) common++;
    }
    return (2 * common) / (o.size - 1 + n.size - 1);
  }

  bottomUp() {
    // Best pairs first, across the whole tree: visiting nodes in tree order would let a removed
    // wrapper claim its parent's counterpart before the parent itself is considered. Matches
    // change their ancestors' scores, so repeat until nothing new matches.
    for (let added = true; added; ) {
      added = false;
      const pairs: { o: Info; n: Info; score: number }[] = [];
      for (const o of this.olds) {
        if (this.fwd.has(o) || !o.children.length) continue;
        const candidates = new Set<Info>();
        for (let j = o.pre + 1; j < o.pre + o.size; j++) {
          for (let a = this.fwd.get(this.olds[j])?.parent; a; a = a.parent) if (!this.back.has(a)) candidates.add(a);
        }
        for (const n of candidates) {
          const d = this.dice(o, n);
          const sameType = n.node.type === o.node.type;
          // A different type needs strong evidence; a same-named node needs only some.
          const ok = sameType ? d >= 0.3 || (n.label === o.label && d > 0) : d >= 0.6;
          if (ok) pairs.push({ o, n, score: d + (sameType ? 0.1 : 0) + (n.label === o.label ? 0.01 : 0) });
        }
      }
      pairs.sort((a, b) => b.score - a.score);
      for (const { o, n } of pairs) {
        if (this.fwd.has(o) || this.back.has(n)) continue;
        this.match(o, n);
        added = true;
      }
    }
    const [o, n] = [this.olds[0], this.news[0]];
    if (o && n && !this.fwd.has(o) && !this.back.has(n)) this.match(o, n);
  }

  recover() {
    const criteria: { key: (x: Info) => unknown; whole: boolean }[] = [
      { key: (x) => x.hash, whole: true },
      { key: (x) => x.label, whole: false },
      { key: (x) => x.node.type, whole: false },
    ];
    // Preorder over the new tree; nodes matched here are visited later in the same loop.
    for (const n of this.news) {
      const o = this.back.get(n);
      if (!o) continue;
      for (const { key, whole } of criteria) {
        const oc = o.children.filter((c) => !this.fwd.has(c));
        const nc = n.children.filter((c) => !this.back.has(c));
        if (!oc.length || !nc.length) break;
        for (const [i, j] of lcs(oc, nc, (a, b) => key(a) === key(b))) {
          if (whole) this.matchSubtree(oc[i], nc[j]);
          else this.match(oc[i], nc[j]);
        }
      }
    }
  }
}

function diffAttrs(a: Record<string, string>, b: Record<string, string>): Record<string, AttrChange> {
  const out: Record<string, AttrChange> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[k] !== b[k]) out[k] = { old: a[k], new: b[k] };
  }
  return out;
}

function diffIndexed(olds: Info[], news: Info[]): TreeDiff {
  const m = new Matcher(olds, news);
  m.topDown();
  m.bottomUp();
  m.recover();

  // Reordered: among children that kept their parent, those outside the longest run that kept its order.
  const reordered = new Set<Info>();
  for (const [o, n] of m.fwd) {
    const kept = o.children.filter((c) => m.fwd.get(c)?.parent === n);
    const order = kept.map((c) => n.children.indexOf(m.fwd.get(c)!));
    const keep = longestIncreasing(order);
    kept.forEach((c, i) => keep.has(i) || reordered.add(c));
  }

  const diff: TreeDiff = { matched: new Map(), oldToNew: new Map(), newToOld: new Map(), added: new Set(), removed: new Set(), changes: 0 };
  for (const [o, n] of m.fwd) {
    const c: NodeChange = {
      oldUid: o.node.uid,
      newUid: n.node.uid,
      attrs: diffAttrs(o.node.attrs, n.node.attrs),
      moved: (o.parent ? m.fwd.get(o.parent) : null) !== n.parent,
      reordered: reordered.has(o),
    };
    if (o.node.type !== n.node.type) c.type = { old: o.node.type, new: n.node.type };
    diff.matched.set(n.node.uid, c);
    diff.oldToNew.set(o.node.uid, n.node.uid);
    diff.newToOld.set(n.node.uid, o.node.uid);
    if (isChanged(c)) diff.changes++;
  }
  for (const o of olds) if (!m.fwd.has(o)) diff.removed.add(o.node.uid);
  for (const n of news) if (!m.back.has(n)) diff.added.add(n.node.uid);
  diff.changes += diff.added.size + diff.removed.size;
  return diff;
}

export function diffTrees(oldRoot: BTNode | null, newRoot: BTNode | null): TreeDiff {
  const interner = new Interner();
  return diffIndexed(index(oldRoot, interner), index(newRoot, interner));
}

export type TreeDefStatus = "added" | "removed" | "renamed" | "changed" | "unchanged";

export interface TreeDefDiff {
  status: TreeDefStatus;
  old?: TreeDef;
  new?: TreeDef;
  nodes: TreeDiff;
  /** Changes to the tree itself rather than its nodes. */
  meta: {
    id?: AttrChange;
    file?: AttrChange;
    description?: AttrChange;
    attrs: Record<string, AttrChange>;
    ports: boolean;
  };
}

function diffMeta(a: TreeDef | undefined, b: TreeDef | undefined): TreeDefDiff["meta"] {
  const change = (x?: string, y?: string) => (a && b && x !== y ? { old: x, new: y } : undefined);
  const meta: TreeDefDiff["meta"] = {
    attrs: a && b ? diffAttrs(a.attrs, b.attrs) : {},
    ports: !!a && !!b && JSON.stringify(a.ports) !== JSON.stringify(b.ports),
  };
  const id = change(a?.id, b?.id);
  const file = change(a?.file, b?.file);
  const description = change(a?.description, b?.description);
  if (id) meta.id = id;
  if (file) meta.file = file;
  if (description) meta.description = description;
  return meta;
}

/**
 * Pairs the trees of two project versions by ID (not by file: trees move between files) and diffs
 * each pair. A removed and an added tree with identical contents are reported as one rename.
 * Result order: the new version's trees in order, then removed ones.
 */
export function diffTreeDefs(oldTrees: TreeDef[], newTrees: TreeDef[]): TreeDefDiff[] {
  const interner = new Interner();
  const indexed = new Map<TreeDef, Info[]>([...oldTrees, ...newTrees].map((t) => [t, index(t.root, interner)]));
  const oldById = new Map(oldTrees.map((t) => [t.id, t]));
  const newIds = new Set(newTrees.map((t) => t.id));

  const renamedFrom = new Map<TreeDef, TreeDef>();
  const unpairedOld = oldTrees.filter((t) => !newIds.has(t.id) && t.root);
  for (const n of newTrees) {
    if (oldById.has(n.id) || !n.root) continue;
    const i = unpairedOld.findIndex((o) => indexed.get(o)![0].hash === indexed.get(n)![0].hash);
    if (i >= 0) renamedFrom.set(n, unpairedOld.splice(i, 1)[0]);
  }
  const renamed = new Set(renamedFrom.values());

  const result: TreeDefDiff[] = [];
  const push = (a: TreeDef | undefined, b: TreeDef | undefined) => {
    const nodes = diffIndexed(a ? indexed.get(a)! : [], b ? indexed.get(b)! : []);
    const meta = diffMeta(a, b);
    let status: TreeDefStatus;
    if (!a) status = "added";
    else if (!b) status = "removed";
    else if (meta.id) status = "renamed";
    else status = nodes.changes || meta.file || meta.description || meta.ports || Object.keys(meta.attrs).length ? "changed" : "unchanged";
    const d: TreeDefDiff = { status, nodes, meta };
    if (a) d.old = a;
    if (b) d.new = b;
    result.push(d);
  };
  for (const n of newTrees) push(oldById.get(n.id) ?? renamedFrom.get(n), n);
  for (const o of oldTrees) if (!newIds.has(o.id) && !renamed.has(o)) push(o, undefined);
  return result;
}
