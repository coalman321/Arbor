import react from "@vitejs/plugin-react";
import { defaultClientConditions, defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The Arbor app's btlog reader imports the package; use its sources.
  resolve: { conditions: ["source", ...defaultClientConditions] },
  server: { fs: { allow: ["../../../.."] } },
});
