import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";
import { deferredEntries } from "./deferred-entries";

export default defineConfig({
  plugins: [deferredEntries()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    coverage: {
      provider: "v8",
      reportsDirectory: "../../coverage/app",
      exclude: [
        "dist/**",
        "test/**",
        "src/**/*.test.ts",
        "src/**/*.test.tsx",
        "src/types.d.ts",
      ],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50,
        statements: 60,
      },
    },
    environment: "jsdom",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "test/**/*.test.ts",
      "test/**/*.test.tsx",
    ],
  },
});
