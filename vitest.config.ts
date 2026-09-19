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
      //
      // Raised after 1.0.2 to the integer floor of what the suite reaches
      // (95.22 / 87.01 / 95.78 / 95.29), with one exception: branches stay at
      // 86 although they measure 87.01. Branch coverage is not perfectly
      // deterministic here — runs of the same commit were seen at both 429 and
      // 430 of 493 — and 87 would demand all 429, leaving no slack at all. A
      // threshold that a re-run can miss is a flaky build, and the ratchet only
      // ever rises, so there would be no way back down.
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 86,
        statements: 95,
      },
    },
  },
});
