import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { collectLicenses } from "./scripts/licenses.mjs";

/** Writes dist/licenses.json: the licence of every library in the bundle (see scripts/licenses.mjs). */
function licenses(): Plugin {
  return {
    name: "arbor-licenses",
    apply: "build",
    generateBundle(_, bundle) {
      const modules = Object.values(bundle).flatMap((c) => (c.type === "chunk" ? Object.keys(c.modules) : []));
      this.emitFile({ type: "asset", fileName: "licenses.json", source: JSON.stringify(collectLicenses(modules), null, 1) + "\n" });
    },
  };
}

// The frontend lives in src/web. In production the backend (src/server/main.ts) serves dist/;
// with --dev it mounts Vite as middleware, so there is only ever one port to open.
export default defineConfig({
  root: "src/web",
  plugins: [react(), licenses()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
