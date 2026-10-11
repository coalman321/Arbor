// Which git to run: the machine's own if it has one, otherwise the copy the desktop app ships with
// (staged by scripts/stage_git.mjs). The bundled copy is laid out by dugite-native, and runs with
// the environment dugite gives it, so it finds its own helpers and config instead of the system's.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { BundledGitInfo } from "../shared/model.ts";

export interface GitBinary {
  path: string;
  /** Environment to run it with; undefined runs it with the server's own. */
  env?: NodeJS.ProcessEnv;
  version: string;
  bundled: boolean;
}

let bundledDir: string | null = null;
let found: Promise<GitBinary | null> | undefined;

/** Uses the git in `dir` when the machine has none of its own. */
export function useBundledGit(dir: string) {
  bundledDir = dir;
  found = undefined;
}

/** The git to run, or null if there's none. Looked up once. */
export function findGit(): Promise<GitBinary | null> {
  found ??= (async () => (await systemGit()) ?? (bundledDir ? bundledGit(bundledDir) : null))();
  return found;
}

function version(path: string, env?: NodeJS.ProcessEnv): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, ["--version"], { env, encoding: "utf8", timeout: 10_000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim().replace(/^git version /, ""));
    });
  });
}

async function systemGit(): Promise<GitBinary | null> {
  // On macOS /usr/bin/git is there even without the Command Line Tools, as a stub that fails and
  // asks to install them. Ask xcode-select instead, which doesn't prompt.
  if (process.platform === "darwin" && onPath("git") === "/usr/bin/git" && !(await succeeds("xcode-select", ["-p"]))) return null;
  const v = await version("git");
  return v ? { path: "git", version: v, bundled: false } : null;
}

async function bundledGit(dir: string): Promise<GitBinary | null> {
  const win = process.platform === "win32";
  const path = join(dir, win ? join("cmd", "git.exe") : join("bin", "git"));
  if (!existsSync(path)) return null;
  // As dugite's setupEnvironment.
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (win) {
    const sub = process.arch === "arm64" ? "clangarm64" : "mingw64";
    const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "Path";
    env[pathKey] = [join(dir, sub, "bin"), join(dir, "usr", "bin"), env[pathKey]].filter(Boolean).join(delimiter);
    env.GIT_EXEC_PATH = join(dir, sub, "libexec", "git-core");
  } else {
    env.GIT_EXEC_PATH = join(dir, "libexec", "git-core");
    env.GIT_CONFIG_SYSTEM ??= join(dir, "etc", "gitconfig");
    env.GIT_TEMPLATE_DIR = join(dir, "share", "git-core", "templates");
    if (process.platform === "linux") env.PREFIX = dir;
  }
  const v = await version(path, env);
  return v ? { path, env, version: v, bundled: true } : null;
}

/** Version, licence, and source of the bundled git, or null if this build has none. */
export async function bundledGitInfo(): Promise<BundledGitInfo | null> {
  if (!bundledDir) return null;
  try {
    const [meta, license] = await Promise.all([readFile(join(bundledDir, "arbor-git.json"), "utf8"), readFile(join(bundledDir, "COPYING"), "utf8")]);
    const { version, source, build } = JSON.parse(meta) as Omit<BundledGitInfo, "license" | "inUse">;
    return { version, source, build, license, inUse: (await findGit())?.bundled ?? false };
  } catch {
    return null;
  }
}

function onPath(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir && existsSync(join(dir, cmd))) return join(dir, cmd);
  }
  return null;
}

function succeeds(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 10_000 }, (err) => resolve(!err)));
}
