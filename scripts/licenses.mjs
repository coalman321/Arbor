// Third-party licence notices for what the builds bundle, so the copy the app ships names each
// library and carries its licence text, as their licences ask. vite.config.ts writes the
// frontend's into dist/licenses.json; scripts/bundle.mjs and scripts/build_binary.mjs add the
// server's, which they bundle too. The app lists them in settings (Open-source licences).

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

/** The licence text for a package that declares MIT but ships no licence file. */
function mitFor(pkg) {
  const author = typeof pkg.author === "string" ? pkg.author.replace(/\s*[<(].*$/, "") : pkg.author?.name;
  const text = `(${pkg.name} ships no licence file; this is the MIT License its package declares.)\n\nMIT License\n\nCopyright (c) ${author ?? `the ${pkg.name} authors`}\n\n${MIT}`;
  return text.split("\n").map(wrap).join("\n");
}

/** Wraps a line at 80 columns, as licence files are; the dialog shows them unwrapped. */
function wrap(line) {
  return line.replace(/(.{1,80})(?: +|$)/g, "$1\n").trimEnd();
}

/** A browsable URL for a package.json "repository": full URLs, "git+https:", or "owner/repo". */
function repoUrl(repo) {
  const url = typeof repo === "string" ? repo : repo?.url;
  if (!url) return null;
  if (/^(github:)?[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url.replace(/^github:/, "")}`;
  return url.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/\.git$/, "");
}

/** The package directory under node_modules holding `file`, or null for our own code. */
function packageDir(file) {
  const parts = resolve(file).split(sep);
  const i = parts.lastIndexOf("node_modules");
  if (i < 0) return null;
  const n = parts[i + 1]?.startsWith("@") ? 3 : 2;
  return parts.length > i + n ? parts.slice(0, i + n).join(sep) : null;
}

function describe(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
  const text = files.map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n");
  const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? "UNKNOWN");
  return {
    name: pkg.name,
    version: pkg.version,
    license,
    homepage: pkg.homepage ?? repoUrl(pkg.repository),
    text: text || (license === "MIT" ? mitFor(pkg) : null),
  };
}

/** Notices for the packages that `files` (bundled module paths) come from. */
export function collectLicenses(files) {
  const dirs = new Set();
  for (const f of files) {
    const dir = packageDir(f.replace(/^\0/, "").replace(/\?.*$/, ""));
    if (dir && existsSync(join(dir, "package.json"))) dirs.add(dir);
  }
  return [...dirs].map(describe).sort(byName);
}

const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version);

/** Adds `entries` to the notices in `file`, one per package version, sorted by name. */
export function addLicenses(file, entries) {
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  const all = new Map([...existing, ...entries].map((e) => [`${e.name}@${e.version}`, e]));
  writeFileSync(file, JSON.stringify([...all.values()].sort(byName), null, 1) + "\n");
}

/** Bundled module paths from an esbuild metafile, which lists them relative to esbuild's `cwd`. */
export function metafileInputs(metafile, cwd) {
  return Object.keys(metafile.inputs).map((p) => resolve(cwd, p));
}
