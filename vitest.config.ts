import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Fixtures are real filesystem trees in a temp dir; keep them serial so the
    // trash-collision and walk-budget assertions stay deterministic.
    fileParallelism: false,
  },
});
