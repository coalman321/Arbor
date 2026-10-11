#!/usr/bin/env node
// Entry point for `npx arbor` / `npm link`: runs the TypeScript server through tsx.
import { register } from "tsx/esm/api";

register();
// A URL rather than a path: import() reads a Windows path like D:\... as a URL with scheme "d:".
await import(new URL("../src/server/main.ts", import.meta.url).href);
