import react from "@vitejs/plugin-react";
import { defineConfig, type UserConfig } from "vite";

// Two builds (see "build" in package.json):
//   vite build               dist/index.js, dist/react.js, dist/style.css: dependencies left to the host
//   vite build --mode mount  dist/mount.js: React, React Flow and the styles bundled in, for any page
export default defineConfig(({ mode }): UserConfig =>
  mode === "mount"
    ? {
        plugins: [react()],
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
        build: {
          emptyOutDir: false,
          minify: true,
          lib: { entry: { mount: "src/mount.tsx" }, formats: ["es"] },
          chunkSizeWarningLimit: 1500,
        },
      }
    : {
        plugins: [react()],
        build: {
          lib: { entry: { index: "src/index.ts", react: "src/react/index.ts", style: "src/style.ts" }, formats: ["es"], cssFileName: "style" },
          rollupOptions: {
            external: [/^react($|\/)/, /^react-dom($|\/)/, /^@xyflow\/react($|\/)/, /^zustand($|\/)/, "fast-xml-parser"],
          },
        },
      },
);
