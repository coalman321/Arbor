import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Use the Arborist workspace package's TypeScript sources directly (its "source" export condition).
  resolve: { conditions: ["source", ...defaultServerConditions] },
  ssr: { resolve: { conditions: ["source", ...defaultServerConditions] } },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
