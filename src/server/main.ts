// arbor command: parses the command line, opens the project and starts the server (server.ts).
//
//   arbor [--project <dir>] [--port 8080] [--host 127.0.0.1] [--root <dir>] [--no-open] [--dev]
//   arbor init <dir>
//
// Without --project, the UI starts on a screen for opening or creating one.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import sea from "node:sea";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { initProject, Project, ProjectError } from "./project.ts";
import { distLoader, startServer, type StaticLoader } from "./server.ts";
import { configDir, Workspace } from "./workspace.ts";

const PACKAGE_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
// Release binaries (scripts/build_binary.mjs) carry the built frontend as SEA assets instead of dist/.
const EMBEDDED = sea.isSea();

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
  const workspace = new Workspace(limit, configDir());
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
  const loadStatic: StaticLoader = EMBEDDED
    ? async (rel) => {
        try {
          return Buffer.from(sea.getAsset(rel));
        } catch {
          return undefined; // no such asset
        }
      }
    : distLoader(distDir);

  const port = Number(values.port);
  const server = await startServer({ workspace, host: values.host!, port, loadStatic, vite }).catch((e: NodeJS.ErrnoException) => {
    console.error(e.code === "EADDRINUSE" ? `Port ${port} is already in use; pick another with --port` : e.message);
    process.exit(1);
  });
  const p = workspace.project;
  const name = p ? (await p.manifest()).name : null;
  console.log(name ? `arbor: project "${name}" (${p!.root})` : "arbor: no project open; pick one in the browser");
  const host = values.host === "0.0.0.0" || values.host === "::" ? "localhost" : values.host!.includes(":") ? `[${values.host}]` : values.host;
  const url = `http://${host}:${port}/`;
  console.log(`           ${url}`);
  if (!values.dev && !values["no-open"]) openBrowser(url);

  const shutdown = () => {
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
