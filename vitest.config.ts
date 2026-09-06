import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      // A ratchet: the thresholds track what the suite actually reaches and
      // may only ever be raised. They were left at the phase 1 values for
      // several phases, during which the real coverage quietly fell — the
      // point of the ratchet is that this shows up as a failing build.
      thresholds: {
        lines: 95,
        functions: 98,
        branches: 90,
        statements: 95,
      },
    },
  },
});
