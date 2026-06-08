import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { nationPoints, participantPoints } from "./scoring.js";
import { recordMatch, updateMatch } from "./matches.js";
import {
  type Assignment,
  type Id,
  type Match,
  type Nation,
  type Participant,
  type SweepstakeState,
} from "./types.js";

// Property-based tests for the scoring rules (Requirement 5). These exercise
// `nationPoints(matches, nationId)` and `participantPoints(state, participantId)`
// from ./scoring.ts. Each property runs at least 100 generated cases.

/**
 * Independent reference for the win/draw component of a single match for the
 * nation that scored `own` goals against an opponent that scored `other`.
 * Deliberately re-derived in the test so it does not share code with the
 * implementation under test.
 */
function winDrawReference(own: number, other: number): number {
  if (own > other) {
    return 3;
  }
  if (own === other) {
    return 1;
  }
  return 0;
}

/** A goal count generator covering the full accepted range incl. boundaries. */
const goalArb = fc.integer({ min: 0, max: 99 });

// --- Single-match contribution properties (26, 27, 28) -----------------------
// For a one-match array, nationPoints(...) equals that nation's win/draw points
// plus its goal points for the match, so subtracting the nation's goal count
// isolates the win/draw component.

describe("Property 26: win awards three win/draw points to the higher scorer only", () => {
  // Feature: worldcup-sweepstake, Property 26: For any match with unequal goal counts, the nation with the higher goal count receives exactly 3 win/draw points and the other receives 0 win/draw points for that match.
  // Validates: Requirements 5.1
  it("gives 3 win/draw points to the higher scorer and 0 to the lower scorer", () => {
    fc.assert(
      fc.property(goalArb, goalArb, (goalsA, goalsB) => {
        fc.pre(goalsA !== goalsB);
        const match: Match = {
          nationAId: "A",
          nationBId: "B",
          goalsA,
          goalsB,
        };
        const higher = goalsA > goalsB ? "A" : "B";
        const lower = goalsA > goalsB ? "B" : "A";
        const higherGoals = Math.max(goalsA, goalsB);
        const lowerGoals = Math.min(goalsA, goalsB);

        const higherWinDraw = nationPoints([match], higher) - higherGoals;
        const lowerWinDraw = nationPoints([match], lower) - lowerGoals;

        expect(higherWinDraw).toBe(3);
        expect(lowerWinDraw).toBe(0);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 27: draw awards one win/draw point to each nation", () => {
  // Feature: worldcup-sweepstake, Property 27: For any match with equal goal counts, each nation receives exactly 1 win/draw point for that match.
  // Validates: Requirements 5.2
  it("gives exactly 1 win/draw point to each nation on a draw", () => {
    fc.assert(
      fc.property(goalArb, (goals) => {
        const match: Match = {
          nationAId: "A",
          nationBId: "B",
          goalsA: goals,
          goalsB: goals,
        };
        expect(nationPoints([match], "A") - goals).toBe(1);
        expect(nationPoints([match], "B") - goals).toBe(1);
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 28: goal points equal goal count", () => {
  // Feature: worldcup-sweepstake, Property 28: For any match, each nation's goal-point component equals that nation's goal count in the match.
  // Validates: Requirements 5.3
  it("gives each nation a goal-point component equal to its own goal count", () => {
    fc.assert(
      fc.property(goalArb, goalArb, (goalsA, goalsB) => {
        const match: Match = {
          nationAId: "A",
          nationBId: "B",
          goalsA,
          goalsB,
        };
        const goalPointsA =
          nationPoints([match], "A") - winDrawReference(goalsA, goalsB);
        const goalPointsB =
          nationPoints([match], "B") - winDrawReference(goalsB, goalsA);

        expect(goalPointsA).toBe(goalsA);
        expect(goalPointsB).toBe(goalsB);
      }),
      { numRuns: 100 },
    );
  });
});

// --- Multi-match / state generators ------------------------------------------

const NATION_POOL = 6;

function nationId(index: number): Id {
  return `n${index}`;
}

function makeNations(count: number): Nation[] {
  return Array.from({ length: count }, (_, i) => ({
    id: nationId(i),
    displayName: `Nation ${i}`,
    normalizedName: `nation ${i}`,
  }));
}

function makeParticipants(count: number): Participant[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    displayName: `Participant ${i}`,
    normalizedName: `participant ${i}`,
  }));
}

function makeState(overrides: Partial<SweepstakeState>): SweepstakeState {
  return {
    participants: [],
    nations: makeNations(NATION_POOL),
    assignments: [],
    matches: [],
    championNationId: null,
    leagueFinalized: false,
    ...overrides,
  };
}

/**
 * Generates a set of distinct unordered-pair matches over the nation pool. Each
 * raw entry references two pool indices and goal counts; entries are deduped by
 * unordered pair so the result respects the {A,B} == {B,A} uniqueness key.
 */
const matchesArb: fc.Arbitrary<Match[]> = fc
  .array(
    fc.record({
      ai: fc.integer({ min: 0, max: NATION_POOL - 1 }),
      bi: fc.integer({ min: 0, max: NATION_POOL - 1 }),
      goalsA: goalArb,
      goalsB: goalArb,
    }),
    { maxLength: 12 },
  )
  .map((raws) => {
    const byPair = new Map<string, Match>();
    for (const { ai, bi, goalsA, goalsB } of raws) {
      if (ai === bi) {
        continue;
      }
      const key = `${Math.min(ai, bi)}-${Math.max(ai, bi)}`;
      byPair.set(key, {
        nationAId: nationId(ai),
        nationBId: nationId(bi),
        goalsA,
        goalsB,
      });
    }
    return [...byPair.values()];
  });

/** Independent naive reference for a nation's total across a match set. */
function nationPointsReference(matches: Match[], nationId: Id): number {
  let total = 0;
  for (const match of matches) {
    if (match.nationAId === nationId) {
      total += winDrawReference(match.goalsA, match.goalsB) + match.goalsA;
    } else if (match.nationBId === nationId) {
      total += winDrawReference(match.goalsB, match.goalsA) + match.goalsB;
    }
  }
  return total;
}

describe("Property 29: nation total points equal summed win/draw and goal points across its matches", () => {
  // Feature: worldcup-sweepstake, Property 29: For any set of stored matches and any nation, the nation's total points equal the sum, over every match the nation played, of its win/draw points plus its goal points (verified against an independent reference computation).
  // Validates: Requirements 5.4
  it("matches an independent naive reference for every nation", () => {
    fc.assert(
      fc.property(
        matchesArb,
        fc.integer({ min: 0, max: NATION_POOL - 1 }),
        (matches, idx) => {
          const id = nationId(idx);
          expect(nationPoints(matches, id)).toBe(
            nationPointsReference(matches, id),
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

/** One participant index per nation in the pool, mapped to assignments. */
const assignmentsArb = (participantCount: number): fc.Arbitrary<Assignment[]> =>
  fc
    .array(fc.integer({ min: 0, max: participantCount - 1 }), {
      minLength: NATION_POOL,
      maxLength: NATION_POOL,
    })
    .map((participantIdx) =>
      participantIdx.map((pIdx, nIdx) => ({
        nationId: nationId(nIdx),
        participantId: `p${pIdx}`,
      })),
    );

describe("Property 30: participant total points equal the sum of assigned nations' totals", () => {
  // Feature: worldcup-sweepstake, Property 30: For any assigned state and set of matches, a participant's total points equal the sum of the total points of that participant's assigned nations, and equal 0 when none of the assigned nations have stored match results.
  // Validates: Requirements 5.5
  const PARTICIPANT_COUNT = 3;

  it("equals the sum of the assigned nations' totals", () => {
    fc.assert(
      fc.property(
        matchesArb,
        assignmentsArb(PARTICIPANT_COUNT),
        fc.integer({ min: 0, max: PARTICIPANT_COUNT - 1 }),
        (matches, assignments, pIdx) => {
          const state = makeState({
            participants: makeParticipants(PARTICIPANT_COUNT),
            assignments,
            matches,
          });
          const participantId = `p${pIdx}`;
          const expected = assignments
            .filter((a) => a.participantId === participantId)
            .reduce(
              (sum, a) => sum + nationPointsReference(matches, a.nationId),
              0,
            );
          expect(participantPoints(state, participantId)).toBe(expected);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("reports 0 when none of the participant's assigned nations have results", () => {
    fc.assert(
      fc.property(
        matchesArb,
        assignmentsArb(PARTICIPANT_COUNT),
        fc.integer({ min: 0, max: PARTICIPANT_COUNT - 1 }),
        (matches, assignments, pIdx) => {
          const participantId = `p${pIdx}`;
          const assignedToP = new Set(
            assignments
              .filter((a) => a.participantId === participantId)
              .map((a) => a.nationId),
          );
          // Keep only matches that do not involve any of p's nations, so p has
          // no stored results regardless of how many nations p holds.
          const matchesWithoutP = matches.filter(
            (m) =>
              !assignedToP.has(m.nationAId) && !assignedToP.has(m.nationBId),
          );
          const state = makeState({
            participants: makeParticipants(PARTICIPANT_COUNT),
            assignments,
            matches: matchesWithoutP,
          });
          expect(participantPoints(state, participantId)).toBe(0);
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("Property 31: points depend only on the current match set, not history", () => {
  // Feature: worldcup-sweepstake, Property 31: For any two sequences of record/update/remove operations that result in the same final set of stored matches, the computed participant totals are identical.
  // Validates: Requirements 5.6
  const PARTICIPANT_COUNT = 3;

  it("yields identical participant totals for two operation sequences with the same final match set", () => {
    fc.assert(
      fc.property(
        matchesArb,
        assignmentsArb(PARTICIPANT_COUNT),
        // A permutation seed and intermediate goals for the update path.
        fc.array(fc.integer(), { maxLength: 12 }),
        goalArb,
        goalArb,
        (finalMatches, assignments, permSeed, interGoalsA, interGoalsB) => {
          const base = makeState({
            participants: makeParticipants(PARTICIPANT_COUNT),
            assignments,
            matches: [],
          });

          // Sequence 1: record each final match directly, in generated order.
          let stateA = base;
          for (const m of finalMatches) {
            const res = recordMatch(stateA, m);
            expect(res.ok).toBe(true);
            if (res.ok) {
              stateA = res.value;
            }
          }

          // Sequence 2: process in a different order, and for each match first
          // record an intermediate result then update it to the final goals —
          // a genuinely different history reaching the same final set.
          const reordered = finalMatches
            .map((m, i) => ({ m, k: permSeed[i] ?? i }))
            .sort((x, y) => x.k - y.k)
            .map((entry) => entry.m);

          let stateB = base;
          for (const m of reordered) {
            const recorded = recordMatch(stateB, {
              nationAId: m.nationAId,
              nationBId: m.nationBId,
              goalsA: interGoalsA,
              goalsB: interGoalsB,
            });
            expect(recorded.ok).toBe(true);
            if (recorded.ok) {
              stateB = recorded.value;
            }
            const updated = updateMatch(stateB, m);
            expect(updated.ok).toBe(true);
            if (updated.ok) {
              stateB = updated.value;
            }
          }

          for (let p = 0; p < PARTICIPANT_COUNT; p += 1) {
            const id = `p${p}`;
            expect(participantPoints(stateB, id)).toBe(
              participantPoints(stateA, id),
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
