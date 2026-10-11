// Library entry point for embedding Arbor in another Node application. Bundled to
// build/lib/arbor.mjs by scripts/bundle.mjs; serve the built frontend (dist/) with distLoader:
//
//   const workspace = new Workspace(null, configDir());
//   const server = await startServer({ workspace, host: "127.0.0.1", port: 0, loadStatic: distLoader(dist) });
//   // UI at http://127.0.0.1:${server.port}/; server.close() stops it.

export { useBundledGit } from "./git_binary.ts";
export { initProject, Project, ProjectError } from "./project.ts";
export { distLoader, startServer, type RunningServer, type ServerOptions, type StaticLoader } from "./server.ts";
export { configDir, Workspace } from "./workspace.ts";
