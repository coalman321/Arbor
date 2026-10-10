// arbor backend: serves the frontend, reads/writes the project directory, pushes file-change
// events, and relays the live robot connection.
//
//   arbor [--project <dir>] [--port 8080] [--host 127.0.0.1] [--root <dir>] [--no-open] [--dev]
//   arbor init <dir>
//
// Without --project, the UI starts on a screen for opening or creating one.

import { spawn } from "node:child_process";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, posix, relative, resolve, sep } from "node:path";
import sea from "node:sea";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { WebSocketServer, type WebSocket } from "ws";
import type { NodeModel, SaveFileRequest } from "../shared/model.ts";
import { relayToRobot } from "./live_relay.ts";
import { initProject, Project, ProjectError } from "./project.ts";
import { Workspace } from "./workspace.ts";

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
// Release binaries (scripts/build_binary.mjs) carry the built frontend as SEA assets instead of dist/.
const EMBEDDED = sea.isSea();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".woff2": "font/woff2",
};

function usage(): never {
  console.log(`Usage:
  arbor [--project <dir>] [--port 8080] [--host 127.0.0.1] [--root <dir>] [--no-open] [--dev]
  arbor init <dir>      create an empty project

  --root <dir>   only let the UI browse, open and create projects under <dir>. Defaults to the
                 current directory when --host isn't a loopback address, and to no limit otherwise.
  --no-open      don't open the UI in the default browser on startup.`);
  process.exit(1);
}

// Best effort: on a headless machine there is no browser to open, and the URL is printed anyway.
function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", '""', url]]
    : ["xdg-open", [url]];
  // windowsVerbatimArguments keeps cmd from mangling start's empty "" window title.
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
  child.on("error", () => {});
  child.unref();
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

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      project: { type: "string", short: "p" },
      port: { type: "string", default: "8080" },
      host: { type: "string", default: "127.0.0.1" },
      root: { type: "string" },
      dev: { type: "boolean", default: false },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) usage();
  // npm scripts run from the package directory; resolve paths against where the user was.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  if (positionals[0] === "init") {
    if (!positionals[1]) usage();
    await initProject(resolve(cwd, positionals[1]));
    console.log(`Created project in ${resolve(cwd, positionals[1])}`);
    return;
  }
  const projectDir = values.project ? resolve(cwd, values.project) : positionals[0] ? resolve(cwd, positionals[0]) : undefined;
  // When reachable from other machines, don't hand them a browser for the whole filesystem.
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(values.host!);
  const limit = values.root ? resolve(cwd, values.root) : loopback ? null : resolve(cwd);
  const configDir = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "bt-editor");
  const workspace = new Workspace(limit, configDir);
  if (projectDir) {
    if (!existsSync(projectDir)) {
      console.error(`Project directory ${projectDir} does not exist (create one with: arbor init <dir>)`);
      process.exit(1);
    }
    try {
      await workspace.open(projectDir); // fail fast on a broken manifest
    } catch (e) {
      if (!(e instanceof ProjectError) || !limit) throw e;
      // Outside --root: still open it, but only because the command line asked for it.
      workspace.project = new Project(projectDir);
      await workspace.project.load();
    }
  }
  const proj = () => workspace.requireProject();

  let vite: import("vite").ViteDevServer | undefined;
  if (values.dev && EMBEDDED) {
    console.error("--dev needs a source checkout; it isn't available in the release binary");
    process.exit(1);
  }
  if (values.dev) {
    const { createServer: createVite } = await import("vite");
    vite = await createVite({
      configFile: join(PACKAGE_ROOT, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { port: Number(values.port) + 1 } },
      appType: "spa",
    });
  }
  const distDir = join(PACKAGE_ROOT, "dist");
  if (!vite && !EMBEDDED && !existsSync(join(distDir, "index.html"))) {
    console.error(`No built frontend in ${distDir}; run \`npm run build\` first, or start with --dev`);
    process.exit(1);
  }

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
      default:
        throw new ProjectError(`No route ${route}`, 404);
    }
  };

  const loadStatic = async (rel: string): Promise<Buffer | undefined> => {
    if (EMBEDDED) {
      try {
        return Buffer.from(sea.getAsset(rel));
      } catch {
        return undefined; // no such asset
      }
    }
    const file = resolve(distDir, rel);
    return file.startsWith(distDir + sep) && existsSync(file) ? readFile(file) : undefined;
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

  const port = Number(values.port);
  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${port} is already in use; pick another with --port` : e.message);
    process.exit(1);
  });
  server.listen(port, values.host, async () => {
    const p = workspace.project;
    const name = p ? (await p.manifest()).name : null;
    console.log(name ? `arbor: project "${name}" (${p!.root})` : "arbor: no project open; pick one in the browser");
    const host = values.host === "0.0.0.0" || values.host === "::" ? "localhost" : values.host!.includes(":") ? `[${values.host}]` : values.host;
    const url = `http://${host}:${port}/`;
    console.log(`           ${url}`);
    if (!values.dev && !values["no-open"]) openBrowser(url);
  });
  const shutdown = () => {
    watcher?.close();
    void vite?.close();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e instanceof ProjectError ? e.message : e);
  process.exit(1);
});
