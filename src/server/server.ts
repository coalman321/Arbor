// The HTTP/WebSocket server behind the UI: serves the frontend, reads/writes the project directory,
// pushes file-change events, and relays the live robot connection. Started by the `arbor` command
// (main.ts) and by the desktop app (src/desktop/main.ts).

import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, posix, relative, resolve, sep } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { NodeModel, SaveFileRequest } from "../shared/model.ts";
import { relayToRobot } from "./live_relay.ts";
import { ProjectError, type Project } from "./project.ts";
import type { Workspace } from "./workspace.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

/** Returns a built frontend file by its path relative to dist/, or undefined if there is none. */
export type StaticLoader = (rel: string) => Promise<Buffer | undefined>;

export function distLoader(distDir: string): StaticLoader {
  return async (rel) => {
    const file = resolve(distDir, rel);
    return file.startsWith(distDir + sep) && existsSync(file) ? readFile(file) : undefined;
  };
}

export interface ServerOptions {
  workspace: Workspace;
  host: string;
  /** 0 picks a free port; the one chosen is in the result. */
  port: number;
  loadStatic: StaticLoader;
  /** With --dev, Vite serves the frontend instead of loadStatic. */
  vite?: import("vite").ViteDevServer;
}

export interface RunningServer {
  port: number;
  close(): void;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 20 * 1024 * 1024) throw new ProjectError("Request body too large", 413);
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProjectError("Body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

/** Resolves once listening; rejects if the port can't be bound (e.g. EADDRINUSE). */
export function startServer({ workspace, host, port, loadStatic, vite }: ServerOptions): Promise<RunningServer> {
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(host);
  const proj = () => workspace.requireProject();

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const route = `${req.method} ${url.pathname}`;
    // Writes say which project they were made in. If another window has switched projects since,
    // refuse rather than write a tree into the wrong project.
    const forRoot = req.headers["x-bt-project"];
    if (typeof forRoot === "string" && forRoot !== workspace.project?.root) {
      throw new ProjectError("The editor has switched to a different project in another window", 409);
    }
    switch (route) {
      case "GET /api/workspace":
        return sendJson(res, 200, await workspace.info());
      case "GET /api/fs":
        return sendJson(res, 200, await workspace.browse(url.searchParams.get("path") ?? workspace.limit ?? homedir()));
      case "POST /api/project/open": {
        const { path } = (await readBody(req)) as { path: string };
        await workspace.open(path);
        return sendJson(res, 200, await proj().load());
      }
      case "POST /api/project/create": {
        const { path } = (await readBody(req)) as { path: string };
        await workspace.create(path);
        return sendJson(res, 200, await proj().load());
      }
      case "POST /api/recent/forget": {
        const { path } = (await readBody(req)) as { path: string };
        await workspace.forget(path);
        return sendJson(res, 200, await workspace.info());
      }
      case "GET /api/project":
        return sendJson(res, 200, await proj().load());
      case "POST /api/trees/import": {
        const { source } = (await readBody(req)) as { source: string };
        return sendJson(res, 200, await workspace.importTree(source));
      }
      case "PUT /api/files": {
        const body = (await readBody(req)) as SaveFileRequest;
        return sendJson(res, 200, await proj().saveTreeFile(body));
      }
      case "DELETE /api/files": {
        await proj().deleteTreeFile(url.searchParams.get("path") ?? "");
        return sendJson(res, 200, {});
      }
      case "PUT /api/spec": {
        const body = (await readBody(req)) as { models: NodeModel[] };
        return sendJson(res, 200, await proj().saveSpec(body.models));
      }
      case "GET /api/git/revs": {
        const repo = await proj().git();
        return sendJson(res, 200, repo ? await repo.info() : { available: false, reason: "This project is not in a git repository" });
      }
      case "GET /api/git/snapshot": {
        const repo = await proj().git();
        if (!repo) throw new ProjectError("This project is not in a git repository", 404);
        return sendJson(res, 200, await repo.snapshot(url.searchParams.get("rev") ?? ""));
      }
      default:
        throw new ProjectError(`No route ${route}`, 404);
    }
  };

  const serveStatic = async (res: ServerResponse, pathname: string) => {
    let rel = posix.normalize(decodeURIComponent(pathname)).replace(/^\/+/, "");
    let body = extname(rel) === "" ? undefined : await loadStatic(rel);
    if (!body) {
      rel = "index.html";
      body = await loadStatic(rel);
    }
    res.writeHead(200, { "content-type": MIME[extname(rel)] ?? "application/octet-stream" });
    res.end(body);
  };

  // When bound to loopback, only answer requests addressed to loopback: a DNS-rebinding page
  // could otherwise reach this server (which writes files) under its own hostname.
  const hostAllowed = (req: IncomingMessage) => {
    if (!loopback) return true;
    const host = (req.headers.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!hostAllowed(req)) {
      res.writeHead(403).end("Forbidden host");
      return;
    }
    try {
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      if (vite) return vite.middlewares(req, res);
      return await serveStatic(res, url.pathname);
    } catch (e) {
      const status = e instanceof ProjectError ? e.status : 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) sendJson(res, status, { error: (e as Error).message });
    }
  });

  // File change events: one socket per browser tab, broadcast on any change under the project.
  const events = new WebSocketServer({ noServer: true });
  const live = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!hostAllowed(req)) return socket.destroy();
    // Only accept sockets from pages this server served; stops other sites from driving the relay.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) {
      socket.destroy();
      return;
    }
    if (url.pathname === "/api/events") events.handleUpgrade(req, socket, head, (ws) => events.emit("connection", ws));
    else if (url.pathname === "/api/live") {
      const target = url.searchParams.get("url") ?? "";
      if (!/^wss?:\/\//.test(target)) return socket.destroy();
      live.handleUpgrade(req, socket, head, (ws) => relayToRobot(ws, target));
    } else if (!vite) socket.destroy(); // Vite's HMR socket uses its own port
  });

  const broadcast = (msg: unknown) => {
    for (const c of events.clients as Set<WebSocket>) c.send(JSON.stringify(msg));
  };
  let pending = new Set<string>();
  let flush: NodeJS.Timeout | null = null;
  let watcher: FSWatcher | null = null;
  const watchProject = (project: Project | null) => {
    watcher?.close();
    watcher = null;
    pending = new Set();
    if (!project) return;
    try {
      watcher = watch(project.root, { recursive: true }, async (_event, name) => {
        if (!name) return;
        const rel = relative(project.root, join(project.root, name.toString())).split(sep).join("/");
        if (!rel.endsWith(".xml") && !rel.endsWith(".json")) return;
        if (rel.includes(".tmp-")) return;
        pending.add(rel);
        if (flush) clearTimeout(flush);
        flush = setTimeout(async () => {
          if (workspace.project !== project) return;
          const changed: string[] = [];
          for (const p of pending) {
            // Ignore the echo of our own writes.
            const now = await project.currentVersion(p).catch(() => undefined);
            if (now === undefined || now !== project.knownVersion(p)) changed.push(p);
          }
          pending = new Set();
          if (changed.length) broadcast({ op: "files_changed", paths: changed });
        }, 150);
      });
    } catch (e) {
      console.warn(`File watching disabled: ${(e as Error).message}`);
    }
  };
  watchProject(workspace.project);
  workspace.onChange((p) => {
    watchProject(p);
    // Other browser tabs follow along.
    broadcast({ op: "project_changed", root: p?.root ?? null });
    if (p) console.log(`arbor: opened ${p.root}`);
  });

  return new Promise((resolveStart, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(port, host, () => {
      server.off("error", rejectStart);
      resolveStart({
        port: (server.address() as AddressInfo).port,
        close: () => {
          watcher?.close();
          for (const c of [...events.clients, ...live.clients]) c.terminate();
          server.close();
        },
      });
    });
  });
}
