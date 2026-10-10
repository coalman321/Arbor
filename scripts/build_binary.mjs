// Builds a standalone `arbor` executable for the current platform as a Node single executable
// application (https://nodejs.org/api/single-executable-applications.html):
//
//   npm run build && node scripts/build_binary.mjs [--out release/arbor]
//
// The server is bundled into one CommonJS file and the built frontend (dist/) is embedded as SEA
// assets, so the binary needs nothing else on disk. It must be built on the platform it targets.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { out: { type: "string", default: "release/arbor" } } });
const exe = resolve(root, values.out + (process.platform === "win32" ? ".exe" : ""));
const work = join(root, "build", "sea");
const dist = join(root, "dist");

if (!existsSync(join(dist, "index.html"))) {
  console.error("No built frontend in dist/; run `npm run build` first");
  process.exit(1);
}
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(dirname(exe), { recursive: true });

// SEA entry points must be CommonJS, where import.meta is empty; stand in the executable's path.
const bundle = join(work, "arbor.cjs");
await build({
  entryPoints: [join(root, "src", "server", "main.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: `node${process.versions.node.split(".")[0]}`,
  banner: { js: 'const __import_meta_url = require("node:url").pathToFileURL(__filename).href;' },
  define: { "import.meta.url": "__import_meta_url" },
  // vite is only loaded for --dev; ws's native speedups are optional.
  external: ["vite", "bufferutil", "utf-8-validate"],
  logLevel: "warning",
});

const assets = {};
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else assets[relative(dist, p).split("\\").join("/")] = p;
  }
};
walk(dist);

const blob = join(work, "arbor.blob");
const config = join(work, "sea-config.json");
writeFileSync(config, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useCodeCache: true, assets }, null, 2));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit", cwd: root });
run(process.execPath, ["--experimental-sea-config", config]);

try {
  if (process.platform === "darwin") {
    // The nodejs.org installer ships a universal binary, which postject can't inject into; keep
    // only the slice for this machine (lipo fails on a binary that is already single-arch).
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    const universal = execFileSync("lipo", ["-archs", process.execPath], { encoding: "utf8" }).trim().includes(" ");
    if (universal) run("lipo", [process.execPath, "-thin", arch, "-output", exe]);
    else copyFileSync(process.execPath, exe);
    run("codesign", ["--remove-signature", exe]);
  } else {
    copyFileSync(process.execPath, exe);
  }
  const postject = join(root, "node_modules", "postject", "dist", "cli.js");
  run(process.execPath, [
    postject, exe, "NODE_SEA_BLOB", blob,
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(process.platform === "darwin" ? ["--macho-segment-name", "NODE_SEA"] : []),
  ]);
  // Apple Silicon refuses to run unsigned binaries; an ad-hoc signature is enough.
  if (process.platform === "darwin") run("codesign", ["--sign", "-", exe]);
} catch (e) {
  rmSync(exe, { force: true }); // don't leave a half-built, unsigned binary behind
  throw e;
}
console.log(`Built ${relative(root, exe)}`);
