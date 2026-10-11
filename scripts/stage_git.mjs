// Copies the git that dugite downloaded for this machine into build/git, which electron-builder
// ships with the desktop app (see "extraResources" in package.json). The app uses it only when the
// machine has no git of its own (src/server/git_binary.ts).
//
//   node scripts/stage_git.mjs
//
// Arbor only reads history, so Git Credential Manager and git-lfs, most of the download, are left
// out. Each release job builds on the platform it targets, so the download always matches.
//
// Git is GPLv2: build/git/COPYING carries its licence and build/git/arbor-git.json its version and
// where its source is, both shown in the app's settings (Open-source licences).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dugite = join(root, "node_modules", "dugite");
const from = join(dugite, "git");
const to = join(root, "build", "git");
const win = process.platform === "win32";

if (!existsSync(from)) {
  console.error("No git in node_modules/dugite/git; run `npm ci` (dugite downloads it on install)");
  process.exit(1);
}

// Git Credential Manager is a .NET app: its executable, assemblies, and native libraries.
const DROP = [
  /^git-credential-manager/,
  /^git-credential-helper-selector/,
  /^git-lfs/,
  /^scalar/,
  /^(Atlassian|Avalonia|GitHub|GitLab|HarfBuzzSharp|SkiaSharp|MicroCom|Microsoft|System)\..*\.dll$/,
  /^(gcmcore|msalruntime|av_libglesv2)\.dll$/,
  /^lib(SkiaSharp|HarfBuzzSharp)\./,
];

function keep(src) {
  const rel = relative(from, src).split(sep);
  const name = basename(src);
  if (DROP.some((re) => re.test(name))) return false;
  // On macOS and Linux the rest of GCM sits among git's programs, which are all git or git-*.
  const i = rel.indexOf("git-core");
  if (!win && i >= 0 && rel.length === i + 2) return name === "git" || name.startsWith("git-") || name === "mergetools";
  return true;
}

rmSync(to, { recursive: true, force: true });
// The programs in libexec/git-core are mostly symlinks to git; copied as such, they cost nothing.
cpSync(from, to, { recursive: true, filter: keep, verbatimSymlinks: true });
cpSync(join(root, "resources", "licenses", "git-COPYING.txt"), join(to, "COPYING"));

// "git version 2.53.0" or, from Git for Windows, "git version 2.52.0.windows.1".
const exe = join(to, win ? join("cmd", "git.exe") : join("bin", "git"));
const version = execFileSync(exe, ["--version"], { encoding: "utf8" }).trim().replace(/^git version /, "");
const embedded = JSON.parse(readFileSync(join(dugite, "script", "embedded-git.json"), "utf8"));
const download = embedded[`${process.platform}-${process.arch}`]?.url ?? "";
const info = {
  version,
  source: version.includes(".windows.")
    ? `https://github.com/git-for-windows/git/tree/v${version}`
    : `https://github.com/git/git/tree/v${version}`,
  // The build scripts and the other open-source parts of this build (on Windows, a minimal MSYS2).
  build: download.replace(/\/download\/([^/]+)\/.*$/, "/tag/$1"),
};
writeFileSync(join(to, "arbor-git.json"), JSON.stringify(info, null, 2) + "\n");

console.log(`Staged git ${version} in build/git`);
