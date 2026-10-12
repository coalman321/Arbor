// A rough BehaviorTree.CPP imitation: instantiates a project tree (expanding SubTrees the way
// BT.CPP does), ticks it, and records status transitions. Leaves succeed or fail at random, so it
// only exercises the live view; it is not a reference for BT.CPP semantics.

import {
  modelFor,
  type BTNode,
  type NodeCategory,
  type NodeModel,
  type NodeStatus,
  type RuntimeNode,
  type StatusChange,
  type TreeDef,
} from "@coalman321/arborist";

interface SimNode {
  uid: number;
  parent: SimNode | null;
  type: string;
  name: string;
  category: NodeCategory;
  attrs: Record<string, string>;
  children: SimNode[];
  subtree?: string;
  treeId: string;
  path: string;
  status: NodeStatus;
  cursor: number;
  remaining: number;
  count: number;
}

export interface SimOptions {
  /** Probability a leaf action succeeds. */
  successRate: number;
  random: () => number;
}

export class Simulator {
  readonly root: SimNode;
  readonly nodes: SimNode[] = [];
  readonly blackboard = new Map<string, Record<string, { type: string; value: unknown }>>();
  private changes: StatusChange[] = [];
  private cooldown = 0;
  private battery = 60;

  constructor(
    readonly mainTreeId: string,
    trees: Map<string, TreeDef>,
    models: Map<string, NodeModel>,
    private opts: SimOptions = { successRate: 0.85, random: Math.random },
  ) {
    const main = trees.get(mainTreeId);
    if (!main?.root) throw new Error(`Tree "${mainTreeId}" is missing or empty`);
    let next = 1;
    const build = (n: BTNode, parent: SimNode | null, tree: TreeDef, prefix: string, depth: number): SimNode => {
      if (depth > 32) throw new Error("SubTree recursion too deep");
      const model = modelFor(n, models);
      const name = n.attrs.name ?? (n.type === "SubTree" ? (n.attrs.ID ?? n.type) : n.type);
      const sim: SimNode = {
        uid: next++,
        parent,
        type: n.type,
        name,
        category: model?.category ?? (n.children.length ? "Control" : "Action"),
        attrs: n.attrs,
        children: [],
        treeId: tree.id,
        path: `${prefix}${name}`,
        status: "IDLE",
        cursor: 0,
        remaining: 0,
        count: 0,
      };
      this.nodes.push(sim);
      if (n.type === "SubTree") {
        const sub = trees.get(n.attrs.ID ?? "");
        if (!sub?.root) throw new Error(`SubTree "${n.attrs.ID}" is missing or empty`);
        sim.subtree = sub.id;
        sim.category = "SubTree";
        this.blackboard.set(sim.path, {});
        sim.children.push(build(sub.root, sim, sub, `${sim.path}/`, depth + 1));
      } else {
        for (const c of n.children) sim.children.push(build(c, sim, tree, prefix, depth));
      }
      return sim;
    };
    this.blackboard.set(mainTreeId, {});
    this.root = build(main.root, null, main, `${mainTreeId}::`, 0);
  }

  runtimeNodes(): RuntimeNode[] {
    return this.nodes.map((n) => ({
      uid: n.uid,
      parent: n.parent?.uid ?? null,
      type: n.type,
      name: n.name,
      category: n.category,
      path: n.path,
      ...(n.subtree ? { subtree: n.subtree } : {}),
    }));
  }

  /** Statuses of all non-IDLE nodes. */
  snapshot(): [number, NodeStatus][] {
    return this.nodes.filter((n) => n.status !== "IDLE").map((n) => [n.uid, n.status]);
  }

  takeChanges(): StatusChange[] {
    const c = this.changes;
    this.changes = [];
    return c;
  }

  private set(n: SimNode, s: NodeStatus) {
    if (n.status === s) return;
    this.changes.push([Date.now(), n.uid, n.status, s]);
    n.status = s;
  }

  private reset(n: SimNode) {
    for (const c of n.children) this.reset(c);
    n.cursor = 0;
    n.remaining = 0;
    n.count = 0;
    this.set(n, "IDLE");
  }

  private resetChildren(n: SimNode) {
    for (const c of n.children) this.reset(c);
  }

  /** One tick of the whole tree, as BT::Tree::tickOnce() would do. */
  tick() {
    this.battery = Math.max(5, this.battery - 0.3);
    this.writeBlackboard(this.mainTreeId, "battery_percent", "double", Math.round(this.battery * 10) / 10);
    if (this.cooldown > 0) {
      if (--this.cooldown === 0) this.reset(this.root);
      return;
    }
    const s = this.tickNode(this.root);
    if (s !== "RUNNING") this.cooldown = 10;
  }

  private writeBlackboard(path: string, key: string, type: string, value: unknown) {
    const bb = this.blackboard.get(path);
    if (bb) bb[key] = { type, value };
  }

  private leafResult(n: SimNode): NodeStatus {
    if (n.type === "AlwaysFailure") return "FAILURE";
    if (n.type === "IsBatteryOk") return this.battery > Number(n.attrs.min_percent ?? 20) ? "SUCCESS" : "FAILURE";
    if (n.type === "ChargeUntil") this.battery = 95;
    return this.opts.random() < this.opts.successRate ? "SUCCESS" : "FAILURE";
  }

  private tickNode(n: SimNode): NodeStatus {
    switch (n.category) {
      case "Condition": {
        this.set(n, this.leafResult(n));
        return n.status;
      }
      case "Action": {
        if (n.status !== "RUNNING") {
          const instant = ["AlwaysSuccess", "AlwaysFailure", "Script", "SetBlackboard", "UnsetBlackboard"].includes(n.type);
          if (instant) {
            if (n.type === "Script") this.writeBlackboard(this.scopeOf(n), "last_script", "std::string", n.attrs.code ?? "");
            this.set(n, n.type === "AlwaysFailure" ? "FAILURE" : "SUCCESS");
            return n.status;
          }
          n.remaining = n.type === "Sleep" ? Math.ceil(Number(n.attrs.msec ?? 1000) / 100) : 3 + Math.floor(this.opts.random() * 10);
          this.set(n, "RUNNING");
          return "RUNNING";
        }
        if (--n.remaining > 0) return "RUNNING";
        const r = this.leafResult(n);
        if (n.type === "DetectObject" && r === "SUCCESS") {
          this.writeBlackboard(this.scopeOf(n), "object_pose", "geometry_msgs::msg::PoseStamped", {
            position: { x: +(this.opts.random() * 3).toFixed(2), y: +(this.opts.random() * 3).toFixed(2), z: 0.8 },
          });
        }
        this.set(n, r);
        return r;
      }
      case "SubTree":
      case "Decorator":
        return this.tickDecorator(n);
      default:
        return this.tickControl(n);
    }
  }

  private scopeOf(n: SimNode): string {
    for (let p = n.parent; p; p = p.parent) if (p.subtree) return p.path;
    return this.mainTreeId;
  }

  private tickDecorator(n: SimNode): NodeStatus {
    const child = n.children[0];
    if (!child) return "FAILURE";
    this.set(n, "RUNNING");
    const s = this.tickNode(child);
    if (s === "RUNNING") return "RUNNING";
    let out: NodeStatus = s;
    switch (n.type) {
      case "Inverter":
        out = s === "SUCCESS" ? "FAILURE" : "SUCCESS";
        break;
      case "ForceSuccess":
        out = "SUCCESS";
        break;
      case "ForceFailure":
        out = "FAILURE";
        break;
      case "RetryUntilSuccessful":
        if (s === "FAILURE" && ++n.count < Number(n.attrs.num_attempts ?? 1)) {
          this.reset(child);
          return "RUNNING";
        }
        break;
      case "Repeat":
        if (s === "SUCCESS" && ++n.count < Number(n.attrs.num_cycles ?? 1)) {
          this.reset(child);
          return "RUNNING";
        }
        break;
      case "KeepRunningUntilFailure":
        if (s === "SUCCESS") {
          this.reset(child);
          return "RUNNING";
        }
        break;
    }
    this.reset(child);
    n.count = 0;
    this.set(n, out);
    return out;
  }

  private tickControl(n: SimNode): NodeStatus {
    this.set(n, "RUNNING");
    const kids = n.children;
    const finish = (s: NodeStatus) => {
      this.resetChildren(n);
      n.cursor = 0;
      this.set(n, s);
      return s;
    };
    if (n.type.startsWith("Parallel")) {
      let ok = 0;
      let bad = 0;
      for (const c of kids) {
        const s = c.status === "SUCCESS" || c.status === "FAILURE" ? c.status : this.tickNode(c);
        if (s === "SUCCESS") ok++;
        if (s === "FAILURE") bad++;
      }
      const needOk = Number(n.attrs.success_count ?? -1);
      const needBad = Number(n.attrs.failure_count ?? 1);
      if (ok >= (needOk < 0 ? kids.length : needOk)) return finish("SUCCESS");
      if (bad >= (needBad < 0 ? kids.length : needBad)) return finish("FAILURE");
      if (ok + bad === kids.length) return finish("FAILURE");
      return "RUNNING";
    }
    if (n.type === "IfThenElse" || n.type === "WhileDoElse") {
      const cond = n.type === "WhileDoElse" || kids[0].status !== "SUCCESS" && kids[0].status !== "FAILURE" ? this.tickNode(kids[0]) : kids[0].status;
      if (cond === "RUNNING") return "RUNNING";
      const branch = cond === "SUCCESS" ? kids[1] : kids[2];
      if (!branch) return finish("FAILURE");
      const s = this.tickNode(branch);
      return s === "RUNNING" ? "RUNNING" : finish(s);
    }
    const isFallback = n.type.includes("Fallback");
    const stopOn: NodeStatus = isFallback ? "SUCCESS" : "FAILURE";
    const reactive = n.type.startsWith("Reactive");
    for (let i = reactive ? 0 : n.cursor; i < kids.length; i++) {
      const s = this.tickNode(kids[i]);
      if (s === "RUNNING") {
        // A reactive node halts whatever was running further right.
        if (reactive) for (const later of kids.slice(i + 1)) this.reset(later);
        n.cursor = i;
        return "RUNNING";
      }
      if (s === stopOn) return finish(s);
    }
    return finish(isFallback ? "FAILURE" : "SUCCESS");
  }
}
