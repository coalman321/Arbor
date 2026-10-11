// Bundles the server with esbuild, for embedding Arbor in other applications and for the desktop app:
//
//   npm run build && node scripts/bundle.mjs
//
//   build/lib/arbor.mjs       library (src/server/index.ts): startServer, Workspace, distLoader, ...
//   build/desktop/main.cjs    Electron main process (src/desktop/main.ts), packaged by electron-builder
//
// Both carry their dependencies (ws, fast-xml-parser) inline; the frontend stays in dist/.

import { existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { addLicenses, collectLicenses, metafileInputs } from "./licenses.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("No built frontend in dist/; run `npm run build` first");
  process.exit(1);
}
rmSync(join(root, "build", "lib"), { recursive: true, force: true });
rmSync(join(root, "build", "desktop"), { recursive: true, force: true });

const common = {
  bundle: true,
  platform: "node",
  target: "node22",
  // vite is only loaded for --dev; ws's native speedups are optional.
  external: ["vite", "bufferutil", "utf-8-validate"],
  // Bundle the Arborist workspace package from its TypeScript sources (its "source" export condition).
  conditions: ["source"],
  logLevel: "warning",
  metafile: true,
  absWorkingDir: root,
};

const lib = await build({
  ...common,
  entryPoints: [join(root, "src", "server", "index.ts")],
  outfile: join(root, "build", "lib", "arbor.mjs"),
  format: "esm",
  // ws is CommonJS and requires Node builtins, which an ES module can only do through createRequire.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
});

const desktop = await build({
  ...common,
  entryPoints: [join(root, "src", "desktop", "main.ts")],
  outfile: join(root, "build", "desktop", "main.cjs"),
  format: "cjs",
  external: [...common.external, "electron"],
});

// The frontend's notices are in dist/licenses.json already; add the server's.
const inputs = [lib, desktop].flatMap((r) => metafileInputs(r.metafile, root));
addLicenses(join(root, "dist", "licenses.json"), collectLicenses(inputs));

console.log("Built build/lib/arbor.mjs and build/desktop/main.cjs");
