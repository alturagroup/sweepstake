import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { buildLeagueTable, getLeagueTable } from "./league.js";
import { participantPoints } from "./scoring.js";
import {
  type Assignment,
  type Id,
  type Match,
  type Nation,
  type Participant,
  type SweepstakeState,
} from "./types.js";

function participant(id: string, displayName: string): Participant {
  return { id, displayName, normalizedName: displayName.trim().toLowerCase() };
}

function nation(id: string, displayName: string): Nation {
  return { id, displayName, normalizedName: displayName.trim().toLowerCase() };
}

function makeState(overrides: Partial<SweepstakeState> = {}): SweepstakeState {
  return {
    participants: [],
    nations: [],
    assignments: [],
    matches: [],
    championNationId: null,
    leagueFinalized: false,
    ...overrides,
  };
}

describe("buildLeagueTable", () => {
  it("returns an empty table for an empty participant list", () => {
    expect(buildLeagueTable(makeState())).toEqual([]);
  });

  it("includes exactly one row per participant", () => {
    const state = makeState({
      participants: [participant("p1", "Alice"), participant("p2", "Bob")],
    });
    const table = buildLeagueTable(state);
    expect(table).toHaveLength(2);
    expect(table.map((row) => row.participantId).sort()).toEqual(["p1", "p2"]);
  });

  it("reports 0 points for participants with no match results", () => {
    const state = makeState({
      participants: [participant("p1", "Alice")],
      nations: [nation("n1", "Brazil")],
      assignments: [{ nationId: "n1", participantId: "p1" } as Assignment],
    });
    const table = buildLeagueTable(state);
    expect(table[0].totalPoints).toBe(0);
    expect(table[0].rank).toBe(1);
  });

  it("orders by points descending and ranks by strictly-greater count", () => {
    // Brazil beats Spain 2-0: Brazil gets 3 (win) + 2 (goals) = 5; Spain 0.
    const matches: Match[] = [
      { nationAId: "nBR", nationBId: "nES", goalsA: 2, goalsB: 0 },
    ];
    const state = makeState({
      participants: [participant("p1", "Alice"), participant("p2", "Bob")],
      nations: [nation("nBR", "Brazil"), nation("nES", "Spain")],
      assignments: [
        { nationId: "nBR", participantId: "p1" },
        { nationId: "nES", participantId: "p2" },
      ],
      matches,
    });
    const table = buildLeagueTable(state);
    expect(table[0]).toMatchObject({
      participantId: "p1",
      totalPoints: 5,
      rank: 1,
    });
    expect(table[1]).toMatchObject({
      participantId: "p2",
      totalPoints: 0,
      rank: 2,
    });
  });

  it("assigns tied participants the same rank", () => {
    const state = makeState({
      participants: [
        participant("p1", "Charlie"),
        participant("p2", "Alice"),
        participant("p3", "Bob"),
      ],
    });
    const table = buildLeagueTable(state);
    // All have 0 points, so all share rank 1.
    expect(table.every((row) => row.rank === 1)).toBe(true);
  });

  it("orders ties by case-insensitive ascending name", () => {
    const state = makeState({
      participants: [
        participant("p1", "charlie"),
        participant("p2", "Alice"),
        participant("p3", "bob"),
      ],
    });
    const table = buildLeagueTable(state);
    expect(table.map((row) => row.displayName)).toEqual([
      "Alice",
      "bob",
      "charlie",
    ]);
  });

  it("skips a rank after tied participants", () => {
    // Two participants tie at the top (rank 1), the next is rank 3.
    const matches: Match[] = [
      // Brazil draws Spain 1-1: each gets 1 (draw) + 1 (goal) = 2.
      { nationAId: "nBR", nationBId: "nES", goalsA: 1, goalsB: 1 },
    ];
    const state = makeState({
      participants: [
        participant("p1", "Alice"),
        participant("p2", "Bob"),
        participant("p3", "Carol"),
      ],
      nations: [nation("nBR", "Brazil"), nation("nES", "Spain")],
      assignments: [
        { nationId: "nBR", participantId: "p1" },
        { nationId: "nES", participantId: "p2" },
      ],
      matches,
    });
    const table = buildLeagueTable(state);
    expect(table[0]).toMatchObject({ totalPoints: 2, rank: 1 });
    expect(table[1]).toMatchObject({ totalPoints: 2, rank: 1 });
    expect(table[2]).toMatchObject({ participantId: "p3", totalPoints: 0, rank: 3 });
  });

  it("does not mutate the input state", () => {
    const state = makeState({
      participants: [participant("p1", "Alice")],
    });
    const before = JSON.stringify(state);
    buildLeagueTable(state);
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("getLeagueTable", () => {
  it("reflects stored matches at request time", () => {
    const state = makeState({
      participants: [participant("p1", "Alice")],
      nations: [nation("nBR", "Brazil")],
      assignments: [{ nationId: "nBR", participantId: "p1" }],
      matches: [{ nationAId: "nBR", nationBId: "nES", goalsA: 3, goalsB: 1 }],
    });
    const table = getLeagueTable(state);
    // Brazil wins: 3 (win) + 3 (goals) = 6.
    expect(table[0].totalPoints).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests for the league table (Requirement 6).
//
// These exercise `buildLeagueTable(state)` from ./league.ts across generated
// states with varied participants (including case/whitespace name variants),
// nations, assignments, and matches chosen so that participant totals vary and
// ties occur frequently. Each property runs at least 100 generated cases and
// validates an independent recomputation of the expected behavior.
// ---------------------------------------------------------------------------

const NATION_POOL = 5;

function poolNationId(index: number): Id {
  return `n${index}`;
}

function poolNations(): Nation[] {
  return Array.from({ length: NATION_POOL }, (_, i) => ({
    id: poolNationId(i),
    displayName: `Nation ${i}`,
    normalizedName: `nation ${i}`,
  }));
}

// A small pool of names that collide case-insensitively (varied case and
// surrounding whitespace) so ties and tie-break ordering are exercised.
const NAME_POOL = [
  "Alice",
  "alice",
  "  ALICE ",
  "Bob",
  "BOB",
  "carol",
  "Carol",
  "Dave",
];

/** Generates a list of participants with varied-case/whitespace names. */
const participantsArb: fc.Arbitrary<Participant[]> = fc
  .array(fc.constantFrom(...NAME_POOL), { minLength: 0, maxLength: 6 })
  .map((names) =>
    names.map((raw, i) => ({
      id: `p${i}`,
      displayName: raw.trim(),
      normalizedName: raw.trim().toLowerCase(),
    })),
  );

/** A goal count generator covering the full accepted range incl. boundaries. */
const goalArb = fc.integer({ min: 0, max: 99 });

/**
 * Generates distinct unordered-pair matches over the nation pool, so totals
 * vary across nations (and therefore participants). Deduped by unordered pair.
 */
const matchesArb: fc.Arbitrary<Match[]> = fc
  .array(
    fc.record({
      ai: fc.integer({ min: 0, max: NATION_POOL - 1 }),
      bi: fc.integer({ min: 0, max: NATION_POOL - 1 }),
      goalsA: goalArb,
      goalsB: goalArb,
    }),
    { maxLength: 10 },
  )
  .map((raws) => {
    const byPair = new Map<string, Match>();
    for (const { ai, bi, goalsA, goalsB } of raws) {
      if (ai === bi) {
        continue;
      }
      const key = `${Math.min(ai, bi)}-${Math.max(ai, bi)}`;
      byPair.set(key, {
        nationAId: poolNationId(ai),
        nationBId: poolNationId(bi),
        goalsA,
        goalsB,
      });
    }
    return [...byPair.values()];
  });

/** Assigns each pool nation to one of the given participants (if any). */
const assignmentsArb = (
  participantCount: number,
): fc.Arbitrary<Assignment[]> => {
  if (participantCount === 0) {
    return fc.constant([] as Assignment[]);
  }
  return fc
    .array(fc.integer({ min: 0, max: participantCount - 1 }), {
      minLength: NATION_POOL,
      maxLength: NATION_POOL,
    })
    .map((participantIdx) =>
      participantIdx.map((pIdx, nIdx) => ({
        nationId: poolNationId(nIdx),
        participantId: `p${pIdx}`,
      })),
    );
};

/** A full generated state with participants, nations, assignments, matches. */
const stateArb: fc.Arbitrary<SweepstakeState> = participantsArb.chain(
  (participants) =>
    fc.record({
      assignments: assignmentsArb(participants.length),
      matches: matchesArb,
    }).map(({ assignments, matches }) => ({
      participants,
      nations: poolNations(),
      assignments,
      matches,
      championNationId: null,
      leagueFinalized: false,
    })),
);

/** Case-insensitive name comparison used by the tie-break ordering. */
function nameCompare(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

describe("Property 32: league table covers every participant exactly once", () => {
  // Feature: worldcup-sweepstake, Property 32: For any state, the league table contains exactly one row per participant in the participant list, each carrying that participant's computed total points, and is empty when the participant list is empty.
  // Validates: Requirements 6.1, 6.6
  it("produces exactly one row per participant carrying its computed total, and an empty table when there are no participants", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const table = buildLeagueTable(state);

        // Exactly one row per participant: same count and same id multiset.
        expect(table).toHaveLength(state.participants.length);
        const tableIds = table.map((row) => row.participantId).sort();
        const participantIds = state.participants
          .map((p) => p.id)
          .sort();
        expect(tableIds).toEqual(participantIds);

        // Each row carries that participant's independently computed total.
        for (const row of table) {
          expect(row.totalPoints).toBe(
            participantPoints(state, row.participantId),
          );
        }

        // Empty participant list yields an empty table.
        if (state.participants.length === 0) {
          expect(table).toEqual([]);
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 33: league ranks are defined by strictly-greater point counts", () => {
  // Feature: worldcup-sweepstake, Property 33: For any league table, each participant's rank equals the number of participants with strictly greater total points plus 1; consequently rows are ordered by total points from highest to lowest and participants with equal points share the same rank.
  // Validates: Requirements 6.2, 6.4, 6.5
  it("assigns rank = (count strictly greater) + 1, orders by points desc, and shares ranks across ties", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const table = buildLeagueTable(state);

        // Rank equals the number of participants with strictly greater total
        // points plus 1.
        for (const row of table) {
          const strictlyGreater = table.filter(
            (other) => other.totalPoints > row.totalPoints,
          ).length;
          expect(row.rank).toBe(strictlyGreater + 1);
        }

        // Rows are ordered by total points from highest to lowest.
        for (let i = 1; i < table.length; i += 1) {
          expect(table[i - 1].totalPoints).toBeGreaterThanOrEqual(
            table[i].totalPoints,
          );
        }

        // Participants with equal points share the same rank.
        for (const a of table) {
          for (const b of table) {
            if (a.totalPoints === b.totalPoints) {
              expect(a.rank).toBe(b.rank);
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});

describe("Property 34: ties are ordered by case-insensitive ascending name", () => {
  // Feature: worldcup-sweepstake, Property 34: For any league table, among participants with equal total points the rows appear in non-decreasing case-insensitive name order.
  // Validates: Requirements 6.3
  it("orders rows of equal total points by non-decreasing case-insensitive name", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        const table = buildLeagueTable(state);

        // Among consecutive rows with equal total points (which, given the
        // points-desc ordering, are exactly the tied groups), names must be in
        // non-decreasing case-insensitive order.
        for (let i = 1; i < table.length; i += 1) {
          if (table[i - 1].totalPoints === table[i].totalPoints) {
            expect(
              nameCompare(table[i - 1].displayName, table[i].displayName),
            ).toBeLessThanOrEqual(0);
          }
        }
      }),
      { numRuns: 100 },
    );
  });
});
