import { describe, expect, it } from "vitest";
import fc from "fast-check";

// Smoke test confirming the test runner (Vitest) and the property-testing
// library (fast-check) are wired up correctly. Replaced by real domain tests.
describe("tooling smoke test", () => {
  it("runs Vitest assertions", () => {
    expect(1 + 1).toBe(2);
  });

  it("runs fast-check property checks", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => {
        return a + b === b + a;
      }),
      { numRuns: 100 },
    );
  });
});
