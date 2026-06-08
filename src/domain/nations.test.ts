import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { addNation, listNations, removeNation } from "./nations.js";
import { MAX_NAME_LENGTH, normalizeName } from "./names.js";
import type { Nation, SweepstakeState } from "./types.js";

// ---------------------------------------------------------------------------
// Test helpers and arbitraries
// ---------------------------------------------------------------------------

/** A fresh, empty sweepstake state. */
function emptyState(): SweepstakeState {
  return {
    participants: [],
    nations: [],
    assignments: [],
    matches: [],
    championNationId: null,
    leagueFinalized: false,
  };
}

/** Build a Nation directly from a display name (normalized via the rules). */
function nationFrom(displayName: string): Nation {
  return {
    id: crypto.randomUUID(),
    displayName,
    normalizedName: normalizeName(displayName),
  };
}

/**
 * Build a state whose nation list is derived from the given "core" names,
 * deduplicated by normalized name so the resulting state is internally
 * consistent (mirrors what addNation would have produced).
 */
function stateWithNations(cores: string[]): SweepstakeState {
  const seen = new Set<string>();
  const nations: Nation[] = [];
  for (const core of cores) {
    const normalized = normalizeName(core);
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    nations.push(nationFrom(core));
  }
  return { ...emptyState(), nations };
}

/** A single non-whitespace character. */
const nonWhitespaceChar = fc
  .char()
  .filter((c) => c.trim().length > 0);

/** Surrounding whitespace padding (may be empty). */
const whitespaceArb = fc.stringOf(
  fc.constantFrom(" ", "\t", "\n", "\r"),
  { maxLength: 5 },
);

/**
 * A valid "core" name: 1..100 non-whitespace characters, so its trimmed length
 * equals its length and it satisfies the 1..100 naming rule.
 */
const validCoreArb = fc
  .array(nonWhitespaceChar, { minLength: 1, maxLength: MAX_NAME_LENGTH })
  .map((chars) => chars.join(""));

/** Wrap a core name with random leading/trailing whitespace. */
function padded(core: string): fc.Arbitrary<string> {
  return whitespaceArb.chain((pre) =>
    whitespaceArb.map((post) => `${pre}${core}${post}`),
  );
}

/** Randomly flip the case of each character in a string. */
function caseVariant(core: string): fc.Arbitrary<string> {
  return fc
    .array(fc.boolean(), { minLength: core.length, maxLength: core.length })
    .map((flips) =>
      core
        .split("")
        .map((ch, i) => (flips[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join(""),
    );
}

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe("nation rules property tests", () => {
  // Feature: worldcup-sweepstake, Property 8: Valid nation is added. For any state and any name that, after trimming, has length 1-100 and does not case-insensitively match an existing nation, adding the nation succeeds and yields a nation list that is exactly one longer and contains the normalized name.
  // Validates: Requirements 2.1
  it("Property 8: adds a valid, non-duplicate nation", () => {
    fc.assert(
      fc.property(
        fc.array(validCoreArb, { maxLength: 8 }),
        validCoreArb,
        whitespaceArb,
        whitespaceArb,
        (existingCores, candidateCore, pre, post) => {
          const state = stateWithNations(existingCores);
          const normalizedCandidate = normalizeName(candidateCore);

          // Only valid, non-duplicate candidates are in scope for this property.
          fc.pre(
            !state.nations.some(
              (n) => n.normalizedName === normalizedCandidate,
            ),
          );

          const rawName = `${pre}${candidateCore}${post}`;
          const result = addNation(state, rawName);

          expect(result.ok).toBe(true);
          if (!result.ok) {
            return;
          }

          const before = listNations(state);
          const after = listNations(result.value);
          expect(after.length).toBe(before.length + 1);
          expect(
            after.some((n) => n.normalizedName === normalizedCandidate),
          ).toBe(true);
          // Original state is left unmutated.
          expect(listNations(state).length).toBe(before.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: worldcup-sweepstake, Property 9: Duplicate nation names are rejected (case-insensitive, trimmed). For any state containing a nation and for any name equal to it after trimming and case-folding, adding it is rejected with DUPLICATE_NATION and the nation list is unchanged.
  // Validates: Requirements 2.2
  it("Property 9: rejects duplicate nation names (case-insensitive, trimmed)", () => {
    // Derived variant arbitrary: the duplicate name shares the normalized form
    // of an existing nation but differs in case and/or surrounding whitespace.
    const variantArb = validCoreArb.chain((dupCore) =>
      caseVariant(dupCore).chain((cased) =>
        padded(cased).map((rawName) => ({ dupCore, rawName })),
      ),
    );

    fc.assert(
      fc.property(
        fc.array(validCoreArb, { maxLength: 8 }),
        variantArb,
        (otherCores, { dupCore, rawName }) => {
          const state = stateWithNations([dupCore, ...otherCores]);
          const before = listNations(state);

          const result = addNation(state, rawName);

          expect(result.ok).toBe(false);
          if (result.ok) {
            return;
          }
          expect(result.error.code).toBe("DUPLICATE_NATION");
          // List unchanged.
          expect(listNations(state)).toEqual(before);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: worldcup-sweepstake, Property 10: Invalid nation names are rejected. For any name that is empty, whitespace-only, or longer than 100 characters after trimming, adding it as a nation is rejected with a validation error and the nation list is unchanged.
  // Validates: Requirements 2.3
  it("Property 10: rejects invalid nation names with a validation error", () => {
    const whitespaceOnlyArb = fc
      .stringOf(fc.constantFrom(" ", "\t", "\n", "\r"), { maxLength: 10 })
      .map((s) => ({ rawName: s, expected: "NAME_REQUIRED" as const }));

    const overLongArb = fc
      .array(nonWhitespaceChar, {
        minLength: MAX_NAME_LENGTH + 1,
        maxLength: MAX_NAME_LENGTH + 50,
      })
      .chain((chars) =>
        padded(chars.join("")).map((rawName) => ({
          rawName,
          expected: "NAME_TOO_LONG" as const,
        })),
      );

    const invalidNameArb = fc.oneof(whitespaceOnlyArb, overLongArb);

    fc.assert(
      fc.property(
        fc.array(validCoreArb, { maxLength: 8 }),
        invalidNameArb,
        (existingCores, { rawName, expected }) => {
          const state = stateWithNations(existingCores);
          const before = listNations(state);

          const result = addNation(state, rawName);

          expect(result.ok).toBe(false);
          if (result.ok) {
            return;
          }
          expect(["NAME_REQUIRED", "NAME_TOO_LONG"]).toContain(
            result.error.code,
          );
          expect(result.error.code).toBe(expected);
          // List unchanged.
          expect(listNations(state)).toEqual(before);
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: worldcup-sweepstake, Property 11: Nation removal before assignments succeeds. For any state with no assignments and any existing nation, removing that nation yields a list that no longer contains it.
  // Validates: Requirements 2.4
  it("Property 11: removes an existing nation when no assignments exist", () => {
    fc.assert(
      fc.property(
        fc.array(validCoreArb, { minLength: 1, maxLength: 10 }),
        fc.nat(),
        (cores, index) => {
          const state = stateWithNations(cores);
          // state has at least one nation (cores has >= 1 entry, dedup keeps >= 1).
          const target =
            state.nations[index % state.nations.length];
          const before = listNations(state);

          const result = removeNation(state, target.id);

          expect(result.ok).toBe(true);
          if (!result.ok) {
            return;
          }
          const after = listNations(result.value);
          expect(after.some((n) => n.id === target.id)).toBe(false);
          expect(after.length).toBe(before.length - 1);
          // Original state is left unmutated.
          expect(listNations(state)).toEqual(before);
        },
      ),
      { numRuns: 100 },
    );
  });
});
