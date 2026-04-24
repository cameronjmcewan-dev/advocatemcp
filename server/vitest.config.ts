import { defineConfig } from "vitest/config";

/**
 * Explicit test exclusion. Vitest's defaults were picking up compiled test
 * files from `dist/` whenever a stale build was present, producing duplicate
 * runs and DB-contention flakes in route tests. Exclude `dist/` + the usual
 * suspects to keep the test surface aligned to `src/`.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
  },
});
