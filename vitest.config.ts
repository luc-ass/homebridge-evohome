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
      //
      // They dropped once, at vitest 5, which made AST-aware remapping the
      // only mode the v8 provider has: it counts statements instead of raw
      // lines, so the denominators changed (992 lines instead of 2491, 235
      // functions instead of 176) and the old percentages stopped describing
      // the same thing. No test was lost and no code became uncovered — the
      // meter changed, and these are the first reading on the new one. From
      // here the ratchet applies as before.
      thresholds: {
        lines: 94,
        functions: 95,
        branches: 86,
        statements: 94,
      },
    },
  },
});
