// Mock robot speaking the btlive protocol (docs/live_protocol.md), for trying the live view
// without hardware:
//
//   npm run mock-robot -- --project examples/demo_project [--tree MainTree] [--port 1670] [--hz 10]

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import {
  LIVE_PROTOCOL,
  LIVE_PROTOCOL_VERSION,
  projectModels,
  type ClientMessage,
  type RobotMessage,
} from "@coalman321/arborist";
import { serializeTreeFile } from "../shared/xml_write.ts";
import { Project } from "../server/project.ts";
import { Simulator } from "./simulator.ts";

async function main() {
  const { values } = parseArgs({
    options: {
      project: { type: "string", short: "p" },
      tree: { type: "string", short: "t" },
      port: { type: "string", default: "1670" },
      hz: { type: "string", default: "10" },
      name: { type: "string", default: "mock-robot" },
    },
  });
  if (!values.project) {
    console.error("Usage: mock-robot --project <dir> [--tree <ID>] [--port 1670] [--hz 10]");
    process.exit(1);
  }
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const snap = await new Project(resolve(cwd, values.project)).load();
  const trees = new Map(snap.trees.map((t) => [t.id, t]));
  const mainTree = values.tree ?? snap.files.find((f) => f.mainTree)?.mainTree ?? snap.trees[0]?.id;
  if (!mainTree) throw new Error("The project has no trees");
  const sim = new Simulator(mainTree, trees, projectModels(snap.specModels, snap.trees));
  const session = 1;
  const xml = serializeTreeFile({ mainTree, includes: [], trees: snap.trees });

  const wss = new WebSocketServer({ port: Number(values.port) });
  const send = (ws: WebSocket, msg: RobotMessage) => ws.send(JSON.stringify(msg));
  wss.on("connection", (ws) => {
    console.log("client connected");
    send(ws, { op: "hello", protocol: LIVE_PROTOCOL, version: LIVE_PROTOCOL_VERSION, robot: values.name });
    send(ws, { op: "tree", session, tree_id: mainTree, nodes: sim.runtimeNodes(), xml });
    send(ws, { op: "snapshot", session, t: Date.now(), statuses: sim.snapshot() });
    ws.on("message", (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return send(ws, { op: "error", message: "invalid JSON" });
      }
      switch (msg.op) {
        case "get_tree":
          return send(ws, { op: "tree", session, tree_id: mainTree, nodes: sim.runtimeNodes(), xml });
        case "get_snapshot":
          return send(ws, { op: "snapshot", session, t: Date.now(), statuses: sim.snapshot() });
        case "get_blackboard":
          return send(ws, {
            op: "blackboard",
            session,
            request_id: msg.request_id,
            blackboards: [...sim.blackboard].map(([path, entries]) => ({
              path,
              tree_id: path === mainTree ? mainTree : (sim.nodes.find((n) => n.path === path)?.subtree ?? path),
              entries,
            })),
          });
        default:
          return send(ws, { op: "error", message: `unknown op ${(msg as { op: string }).op}` });
      }
    });
  });

  setInterval(() => {
    sim.tick();
    const changes = sim.takeChanges();
    if (!changes.length) return;
    const msg = JSON.stringify({ op: "status", session, changes } satisfies RobotMessage);
    for (const c of wss.clients) c.send(msg);
  }, 1000 / Number(values.hz));

  console.log(`mock-robot: ticking "${mainTree}" (${sim.nodes.length} nodes) on ws://localhost:${values.port}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
