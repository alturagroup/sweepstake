import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { listMatches, recordMatch, updateMatch, deleteMatch, type MatchInput } from "./matches.js";
import type { Match, Nation, SweepstakeState } from "./types.js";

const NUM_RUNS = 100;

/** Build a Nation value object from an id. */
function makeNation(id: string): Nation {
  return { id, displayName: id, normalizedName: id.toLowerCase() };
}

/** A base state carrying the given nations and (optionally) stored matches. */
function makeState(nations: Nation[], matches: Match[] = []): SweepstakeState {
  return {
    participants: [],
    nations,
    assignments: [],
    matches,
    championNationId: null,
    leagueFinalized: false,
  };
}

/** Arbitrary for a set of nations with distinct ids (between `min` and 8). */
function nationsArb(min: number): fc.Arbitrary<Nation[]> {
  return fc
    .uniqueArray(
      fc.string({ minLength: 1, maxLength: 6 }).filter((s) => s.trim().length > 0),
      { minLength: min, maxLength: 8 },
    )
    .map((ids) => ids.map(makeNation));
}

/** Valid goal count: integer in 0..99 (includes boundaries 0 and 99). */
const validGoalsArb = fc.integer({ min: 0, max: 99 });

/** Whether a stored match equals the unordered pair {a, b}. */
function isPair(m: Match, a: string, b: string): boolean {
  return (
    (m.nationAId === a && m.nationBId === b) ||
    (m.nationAId === b && m.nationBId === a)
  );
}

/** Find the goals recorded for nation `id` in a match, regardless of orientation. */
function goalsFor(m: Match, id: string): number {
  return m.nationAId === id ? m.goalsA : m.goalsB;
}

// Feature: worldcup-sweepstake, Property 20: Valid match is recorded and retrievable. For any state with at least two nations, recording a match between two distinct existing nations with goal counts in 0-99 stores the match so it is retrievable by its unordered nation pair with the submitted goals.
// Validates: Requirements 4.1
describe("Property 20: valid match is recorded and retrievable", () => {
  it("stores a valid match retrievable by unordered pair with submitted goals", () => {
    fc.assert(
      fc.property(
        nationsArb(2),
        validGoalsArb,
        validGoalsArb,
        fc.nat(),
        fc.nat(),
        (nations, goalsA, goalsB, iRaw, jRaw) => {
          // Pick two distinct nations by index.
          const i = iRaw % nations.length;
          let j = jRaw % nations.length;
          if (j === i) j = (j + 1) % nations.length;
          const a = nations[i];
          const b = nations[j];
          const state = makeState(nations);
          const input: MatchInput = {
            nationAId: a.id,
            nationBId: b.id,
            goalsA,
            goalsB,
          };
          const result = recordMatch(state, input);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          const stored = listMatches(result.value).find((m) =>
            isPair(m, a.id, b.id),
          );
          expect(stored).toBeDefined();
          if (!stored) return;
          expect(goalsFor(stored, a.id)).toBe(goalsA);
          expect(goalsFor(stored, b.id)).toBe(goalsB);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// Feature: worldcup-sweepstake, Property 21: Matches referencing unknown nations are rejected. For any match in which at least one nation is not in the nation list, recording is rejected with UNKNOWN_NATION and the stored matches are unchanged.
// Validates: Requirements 4.2
describe("Property 21: unknown nations are rejected with UNKNOWN_NATION", () => {
  it("rejects matches referencing a nation not in the nation list and leaves matches unchanged", () => {
    fc.assert(
      fc.property(
        nationsArb(1),
        fc.string({ minLength: 1, maxLength: 6 }),
        validGoalsArb,
        validGoalsArb,
        fc.boolean(),
        (nations, unknownRaw, goalsA, goalsB, unknownIsA) => {
          // Ensure the "unknown" id is genuinely not a known nation.
          const knownIds = new Set(nations.map((n) => n.id));
          const unknownId = knownIds.has(unknownRaw)
            ? `${unknownRaw}_x_unknown`
            : unknownRaw;
          fc.pre(!knownIds.has(unknownId));

          const known = nations[0];
          const input: MatchInput = unknownIsA
            ? { nationAId: unknownId, nationBId: known.id, goalsA, goalsB }
            : { nationAId: known.id, nationBId: unknownId, goalsA, goalsB };

          const state = makeState(nations);
          const result = recordMatch(state, input);
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("UNKNOWN_NATION");
          expect(listMatches(state)).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// Feature: worldcup-sweepstake, Property 22: Matches with identical nations are rejected. For any match whose two nations are the same, recording is rejected with NATIONS_NOT_DISTINCT and the stored matches are unchanged.
// Validates: Requirements 4.3
describe("Property 22: identical nations are rejected with NATIONS_NOT_DISTINCT", () => {
  it("rejects matches whose two nations are identical and leaves matches unchanged", () => {
    fc.assert(
      fc.property(
        nationsArb(1),
        validGoalsArb,
        validGoalsArb,
        (nations, goalsA, goalsB) => {
          const n = nations[0];
          const input: MatchInput = {
            nationAId: n.id,
            nationBId: n.id,
            goalsA,
            goalsB,
          };
          const state = makeState(nations);
          const result = recordMatch(state, input);
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("NATIONS_NOT_DISTINCT");
          expect(listMatches(state)).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// Feature: worldcup-sweepstake, Property 23: Out-of-range goal counts are rejected. For any match whose goal count for either nation is non-integer, less than 0, or greater than 99, recording is rejected with GOALS_OUT_OF_RANGE and the stored matches are unchanged.
// Validates: Requirements 4.4
describe("Property 23: out-of-range goal counts are rejected with GOALS_OUT_OF_RANGE", () => {
  // Arbitrary producing an invalid goal count: <0, >99, or non-integer.
  const invalidGoalsArb = fc.oneof(
    fc.integer({ min: -1000, max: -1 }), // below 0 (includes -1 boundary region)
    fc.integer({ min: 100, max: 1000 }), // above 99 (includes 100 boundary region)
    fc
      .double({ min: 0, max: 99, noNaN: true })
      .filter((d) => !Number.isInteger(d)), // non-integer in range
  );

  it("rejects matches with at least one out-of-range goal count and leaves matches unchanged", () => {
    fc.assert(
      fc.property(
        nationsArb(2),
        invalidGoalsArb,
        validGoalsArb,
        fc.boolean(),
        (nations, invalidGoals, validGoals, invalidIsA) => {
          const a = nations[0];
          const b = nations[1];
          const input: MatchInput = {
            nationAId: a.id,
            nationBId: b.id,
            goalsA: invalidIsA ? invalidGoals : validGoals,
            goalsB: invalidIsA ? validGoals : invalidGoals,
          };
          const state = makeState(nations);
          const result = recordMatch(state, input);
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("GOALS_OUT_OF_RANGE");
          expect(listMatches(state)).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("accepts the goal boundaries 0 and 99 and rejects -1, 100, and non-integers", () => {
    const a = makeNation("A");
    const b = makeNation("B");
    const state = makeState([a, b]);
    const base = { nationAId: a.id, nationBId: b.id };

    // Boundaries 0 and 99 are valid.
    expect(recordMatch(state, { ...base, goalsA: 0, goalsB: 99 }).ok).toBe(true);
    expect(recordMatch(state, { ...base, goalsA: 99, goalsB: 0 }).ok).toBe(true);

    // -1, 100, and a non-integer are invalid.
    for (const bad of [-1, 100, 1.5]) {
      const r1 = recordMatch(state, { ...base, goalsA: bad, goalsB: 0 });
      const r2 = recordMatch(state, { ...base, goalsA: 0, goalsB: bad });
      expect(r1.ok).toBe(false);
      expect(r2.ok).toBe(false);
      if (!r1.ok) expect(r1.error.code).toBe("GOALS_OUT_OF_RANGE");
      if (!r2.ok) expect(r2.error.code).toBe("GOALS_OUT_OF_RANGE");
    }
  });
});

// Feature: worldcup-sweepstake, Property 24: Updating an existing match replaces its result. For any stored match identified by its unordered nation pair, updating it with new valid goal counts replaces the stored goals with the new values and leaves the number of stored matches unchanged.
// Validates: Requirements 4.5
describe("Property 24: updating an existing match replaces its result", () => {
  it("replaces stored goals and keeps the match count unchanged", () => {
    fc.assert(
      fc.property(
        nationsArb(2),
        validGoalsArb,
        validGoalsArb,
        validGoalsArb,
        validGoalsArb,
        fc.boolean(),
        (nations, g1A, g1B, g2A, g2B, updateSwapped) => {
          const a = nations[0];
          const b = nations[1];
          const recorded = recordMatch(makeState(nations), {
            nationAId: a.id,
            nationBId: b.id,
            goalsA: g1A,
            goalsB: g1B,
          });
          expect(recorded.ok).toBe(true);
          if (!recorded.ok) return;
          const stateWithMatch = recorded.value;
          const countBefore = listMatches(stateWithMatch).length;

          // Update, possibly referencing the pair in swapped orientation.
          const updateInput: MatchInput = updateSwapped
            ? { nationAId: b.id, nationBId: a.id, goalsA: g2B, goalsB: g2A }
            : { nationAId: a.id, nationBId: b.id, goalsA: g2A, goalsB: g2B };

          const updated = updateMatch(stateWithMatch, updateInput);
          expect(updated.ok).toBe(true);
          if (!updated.ok) return;

          const matches = listMatches(updated.value);
          expect(matches.length).toBe(countBefore);
          const stored = matches.find((m) => isPair(m, a.id, b.id));
          expect(stored).toBeDefined();
          if (!stored) return;
          // Regardless of update orientation, goals for each nation are the new values.
          expect(goalsFor(stored, a.id)).toBe(g2A);
          expect(goalsFor(stored, b.id)).toBe(g2B);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// Feature: worldcup-sweepstake, Property 25: Updating a non-stored match is rejected. For any nation pair with no stored match, updating is rejected with MATCH_NOT_FOUND and the stored matches are unchanged.
// Validates: Requirements 4.6, 4.7
describe("Property 25: updating a non-stored match is rejected with MATCH_NOT_FOUND", () => {
  it("rejects updates for an unstored nation pair and leaves matches unchanged", () => {
    fc.assert(
      fc.property(
        nationsArb(2),
        validGoalsArb,
        validGoalsArb,
        (nations, goalsA, goalsB) => {
          // State has nations but no stored matches.
          const state = makeState(nations);
          const a = nations[0];
          const b = nations[1];
          const result = updateMatch(state, {
            nationAId: a.id,
            nationBId: b.id,
            goalsA,
            goalsB,
          });
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("MATCH_NOT_FOUND");
          expect(listMatches(state)).toEqual([]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

// Deleting a stored match removes it; deleting a non-stored pair is rejected
// and leaves stored matches unchanged.
describe("deleteMatch", () => {
  it("removes a stored match by its unordered pair and recomputes from the rest", () => {
    fc.assert(
      fc.property(
        nationsArb(2),
        validGoalsArb,
        validGoalsArb,
        fc.boolean(),
        (nations, goalsA, goalsB, deleteSwapped) => {
          const a = nations[0];
          const b = nations[1];
          const recorded = recordMatch(makeState(nations), {
            nationAId: a.id,
            nationBId: b.id,
            goalsA,
            goalsB,
          });
          expect(recorded.ok).toBe(true);
          if (!recorded.ok) return;
          const before = listMatches(recorded.value).length;

          const result = deleteSwapped
            ? deleteMatch(recorded.value, b.id, a.id)
            : deleteMatch(recorded.value, a.id, b.id);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(listMatches(result.value).length).toBe(before - 1);
          expect(
            listMatches(result.value).some((m) => isPair(m, a.id, b.id)),
          ).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it("rejects deleting a non-stored pair with MATCH_NOT_FOUND and leaves matches unchanged", () => {
    fc.assert(
      fc.property(nationsArb(2), (nations) => {
        const state = makeState(nations);
        const result = deleteMatch(state, nations[0].id, nations[1].id);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe("MATCH_NOT_FOUND");
        expect(listMatches(state)).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
