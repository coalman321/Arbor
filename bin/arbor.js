#!/usr/bin/env node
// Entry point for `npx arbor` / `npm link`: runs the TypeScript server through tsx.
import { register as registerHooks } from "node:module";
import { register } from "tsx/esm/api";

// Load the Arborist workspace package from its TypeScript sources (its "source" export condition),
// as `tsx --conditions=source` does for the npm scripts.
registerHooks(
  "data:text/javascript," +
    encodeURIComponent("export function resolve(s, c, next) { return next(s, { ...c, conditions: [...c.conditions, 'source'] }); }"),
);
register();
// A URL rather than a path: import() reads a Windows path like D:\... as a URL with scheme "d:".
await import(new URL("../src/server/main.ts", import.meta.url).href);
