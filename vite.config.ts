import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The frontend lives in src/web. In production the backend (src/server/main.ts) serves dist/;
// with --dev it mounts Vite as middleware, so there is only ever one port to open.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  build: {
    outDir: "../../dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
});
