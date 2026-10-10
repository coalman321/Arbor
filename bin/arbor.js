#!/usr/bin/env node
// Entry point for `npx arbor` / `npm link`: runs the TypeScript server through tsx.
import { register } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

register();
await import(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "server", "main.ts"));
