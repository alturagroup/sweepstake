import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  finalizeLeague,
  leaguePrize,
  recordChampion,
  tournamentWinner,
} from "./prizes.js";
import { buildLeagueTable } from "./league.js";
import type {
  Assignment,
  Match,
  Nation,
  Participant,
  SweepstakeState,
} from "./types.js";

// Property-based tests for the Tournament_Winner_Prize rules in prizes.ts.
//
// These tests build whole SweepstakeState values via fast-check arbitraries so
// that a recorded/candidate champion nation may be either assigned to a
// participant or present-but-unassigned, exercising every rejection and
// success path of recordChampion / tournamentWinner.

const NUM_RUNS = 100;

/** Generate a small, unique set of ids with the given prefix. */
function uniqueIds(prefix: string): fc.Arbitrary<string[]> {
  return fc
    .uniqueArray(fc.integer({ min: 0, max: 999 }), { minLength: 1, maxLength: 6 })
    .map((nums) => nums.map((n) => `${prefix}-${n}`));
}

function participantOf(id: string): Participant {
  return {
    id,
    displayName: `Participant ${id}`,
    normalizedName: `participant ${id}`,
  };
}

function nationOf(id: string): Nation {
  return {
    id,
    displayName: `Nation ${id}`,
    normalizedName: `nation ${id}`,
  };
}

/**
 * Base arbitrary producing a coherent SweepstakeState with participants,
 * nations, and a (possibly partial) set of assignments. No champion recorded.
 *
 * Each nation is independently either assigned to some participant or left
 * unassigned, so the generated states include both assigned and unassigned
 * nations.
 */
const stateArb: fc.Arbitrary<SweepstakeState> = fc
  .record({
    participantIds: uniqueIds("p"),
    nationIds: uniqueIds("n"),
  })
  .chain(({ participantIds, nationIds }) => {
    const participants = participantIds.map(participantOf);
    const nations = nationIds.map(nationOf);

    // For each nation decide whether it is assigned and, if so, to whom.
    const assignmentChoicesArb = fc.tuple(
      ...nations.map(() =>
        fc.option(fc.constantFrom(...participantIds), { nil: null }),
      ),
    );

    return assignmentChoicesArb.map((choices) => {
      const assignments: Assignment[] = [];
      choices.forEach((participantId, index) => {
        if (participantId !== null) {
          assignments.push({ nationId: nations[index].id, participantId });
        }
      });

      return {
        participants,
        nations,
        assignments,
        matches: [],
        championNationId: null,
        leagueFinalized: false,
      } satisfies SweepstakeState;
    });
  });

/** True when at least one nation in the state has an assignment. */
function hasAssignedNation(state: SweepstakeState): boolean {
  return state.assignments.length > 0;
}

/** Pick an assigned nation id from a state (caller ensures one exists). */
function anAssignedNationId(state: SweepstakeState): string {
  return state.assignments[0].nationId;
}

describe("recordChampion / tournamentWinner properties", () => {
  // Feature: worldcup-sweepstake, Property 35: An assigned champion identifies its holder — recording a champion that is assigned to a participant identifies exactly that single participant as the Tournament_Winner_Prize recipient.
  // Validates: Requirements 7.1
  it("Property 35: an assigned champion identifies exactly its holding participant", () => {
    fc.assert(
      fc.property(
        stateArb.filter(hasAssignedNation),
        (state) => {
          const nationId = anAssignedNationId(state);
          const expectedHolder = state.assignments.find(
            (a) => a.nationId === nationId,
          )!.participantId;

          const recorded = recordChampion(state, nationId);
          expect(recorded.ok).toBe(true);
          if (!recorded.ok) return;

          const winner = tournamentWinner(recorded.value);
          expect(winner.ok).toBe(true);
          if (!winner.ok) return;

          // Exactly the single holding participant is identified.
          expect(winner.value.id).toBe(expectedHolder);

          // It is genuinely the one and only assignment holder for that nation.
          const holders = recorded.value.assignments
            .filter((a) => a.nationId === nationId)
            .map((a) => a.participantId);
          expect(holders).toEqual([expectedHolder]);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: worldcup-sweepstake, Property 36: An unknown champion nation is rejected — recording a champion nation not in the nation list is rejected with UNKNOWN_NATION and the state is unchanged.
  // Validates: Requirements 7.2
  it("Property 36: recording an unknown nation is rejected with UNKNOWN_NATION and leaves state unchanged", () => {
    const unknownIdArb = fc.string({ minLength: 1, maxLength: 8 });
    fc.assert(
      fc.property(stateArb, unknownIdArb, (state, rawUnknown) => {
        // Ensure the id is genuinely absent from the nation list.
        const unknownId = `unknown-${rawUnknown}`;
        fc.pre(!state.nations.some((n) => n.id === unknownId));

        const before = structuredClone(state);
        const result = recordChampion(state, unknownId);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toEqual({ code: "UNKNOWN_NATION", nation: unknownId });

        // State unchanged (pure function does not mutate its input).
        expect(state).toEqual(before);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: worldcup-sweepstake, Property 37: A champion present but unassigned is rejected — recording a nation that exists but has no assignment is rejected with CHAMPION_NOT_ASSIGNED and the state is unchanged.
  // Validates: Requirements 7.3
  it("Property 37: recording an existing-but-unassigned nation is rejected with CHAMPION_NOT_ASSIGNED and leaves state unchanged", () => {
    const unassignedArb = stateArb.filter((state) =>
      state.nations.some(
        (n) => !state.assignments.some((a) => a.nationId === n.id),
      ),
    );

    fc.assert(
      fc.property(unassignedArb, (state) => {
        const unassigned = state.nations.find(
          (n) => !state.assignments.some((a) => a.nationId === n.id),
        )!;

        const before = structuredClone(state);
        const result = recordChampion(state, unassigned.id);

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toEqual({ code: "CHAMPION_NOT_ASSIGNED" });

        expect(state).toEqual(before);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: worldcup-sweepstake, Property 38: Recording a new champion replaces the previous one — recording a champion after one has already been recorded results in the Tournament_Winner_Prize recipient corresponding only to the most recently recorded champion.
  // Validates: Requirements 7.4
  it("Property 38: recording a new champion replaces the previous one", () => {
    // Require at least two distinct assigned nations so a replacement is meaningful.
    const twoAssignedArb = stateArb.filter((state) => {
      const assignedNationIds = new Set(
        state.assignments.map((a) => a.nationId),
      );
      return assignedNationIds.size >= 2;
    });

    fc.assert(
      fc.property(twoAssignedArb, (state) => {
        const assignedNationIds = [
          ...new Set(state.assignments.map((a) => a.nationId)),
        ];
        const [first, second] = assignedNationIds;

        const afterFirst = recordChampion(state, first);
        expect(afterFirst.ok).toBe(true);
        if (!afterFirst.ok) return;

        const afterSecond = recordChampion(afterFirst.value, second);
        expect(afterSecond.ok).toBe(true);
        if (!afterSecond.ok) return;

        // Champion now reflects only the most recently recorded nation.
        expect(afterSecond.value.championNationId).toBe(second);

        const expectedHolder = state.assignments.find(
          (a) => a.nationId === second,
        )!.participantId;

        const winner = tournamentWinner(afterSecond.value);
        expect(winner.ok).toBe(true);
        if (!winner.ok) return;
        expect(winner.value.id).toBe(expectedHolder);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: worldcup-sweepstake, Property 39: Tournament winner is unavailable until a champion is recorded — with no champion recorded, requesting the Tournament_Winner_Prize recipient returns a CHAMPION_NOT_RECORDED status.
  // Validates: Requirements 7.6
  it("Property 39: tournament winner is unavailable (CHAMPION_NOT_RECORDED) until a champion is recorded", () => {
    fc.assert(
      fc.property(stateArb, (state) => {
        // stateArb always produces championNationId === null.
        expect(state.championNationId).toBeNull();

        const result = tournamentWinner(state);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toEqual({ code: "CHAMPION_NOT_RECORDED" });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// Property-based tests for the League_Prize rules in prizes.ts (Properties 40, 41).
//
// These build whole SweepstakeState values with participants, nations,
// assignments, and matches so that participant point totals — and therefore
// rank-1 membership (unique top vs shared/tied top) — vary across runs. The
// production league-table builder (buildLeagueTable) is used as an independent
// cross-check for the expected rank-1 set.

/**
 * Arbitrary for a coherent SweepstakeState with varied points and ties.
 *
 * - 1–5 participants with distinct display names (varied case to exercise
 *   case-insensitive tie ordering).
 * - 2–6 nations, each assigned to one of the participants.
 * - 0–6 matches between distinct nation pairs with goal counts 0–4, producing
 *   a spread of point totals (and frequently ties, since many participants
 *   share 0 points or equal results).
 *
 * `leagueFinalized` is left false here; tests finalize via finalizeLeague.
 */
const leagueStateArb: fc.Arbitrary<SweepstakeState> = fc
  .record({
    // Distinct participant display names; mixed case so normalization matters.
    participantNames: fc.uniqueArray(
      fc.constantFrom(
        "Alice",
        "bob",
        "Carol",
        "dave",
        "Eve",
        "frank",
        "Grace",
      ),
      { minLength: 1, maxLength: 5 },
    ),
    nationCount: fc.integer({ min: 2, max: 6 }),
  })
  .chain(({ participantNames, nationCount }) => {
    const participants: Participant[] = participantNames.map((name, i) => ({
      id: `p-${i}`,
      displayName: name,
      normalizedName: name.trim().toLowerCase(),
    }));
    const nations: Nation[] = Array.from({ length: nationCount }, (_, i) => ({
      id: `n-${i}`,
      displayName: `Nation ${i}`,
      normalizedName: `nation ${i}`,
    }));

    // Each nation assigned to exactly one (randomly chosen) participant.
    const assignmentsArb = fc
      .tuple(...nations.map(() => fc.constantFrom(...participants.map((p) => p.id))))
      .map((participantIds) =>
        nations.map(
          (n, i): Assignment => ({ nationId: n.id, participantId: participantIds[i] }),
        ),
      );

    // Matches over distinct unordered nation pairs with small goal counts.
    const pairArb = fc
      .uniqueArray(fc.integer({ min: 0, max: nationCount - 1 }), {
        minLength: 2,
        maxLength: 2,
      })
      .map(([a, b]) => [a, b] as const);
    const matchArb = fc
      .record({
        pair: pairArb,
        goalsA: fc.integer({ min: 0, max: 4 }),
        goalsB: fc.integer({ min: 0, max: 4 }),
      })
      .map(
        ({ pair, goalsA, goalsB }): Match => ({
          nationAId: `n-${pair[0]}`,
          nationBId: `n-${pair[1]}`,
          goalsA,
          goalsB,
        }),
      );

    const matchesArb = fc
      .array(matchArb, { minLength: 0, maxLength: 6 })
      // De-duplicate by unordered nation pair to keep match identity unique.
      .map((matches) => {
        const seen = new Set<string>();
        const result: Match[] = [];
        for (const m of matches) {
          const key = [m.nationAId, m.nationBId].sort().join("|");
          if (!seen.has(key)) {
            seen.add(key);
            result.push(m);
          }
        }
        return result;
      });

    return fc.record({ assignments: assignmentsArb, matches: matchesArb }).map(
      ({ assignments, matches }): SweepstakeState => ({
        participants,
        nations,
        assignments,
        matches,
        championNationId: null,
        leagueFinalized: false,
      }),
    );
  });

describe("leaguePrize properties", () => {
  // Feature: worldcup-sweepstake, Property 40: League prize recipients are exactly the rank-1 participants — for any finalized state, the set of League_Prize recipients equals exactly the set of participants holding rank position 1 in the league table (a single participant when the top is unique and all tied participants when the top is shared).
  // Validates: Requirements 8.1, 8.2, 8.3
  it("Property 40: league prize recipients are exactly the rank-1 participants", () => {
    fc.assert(
      fc.property(leagueStateArb, (baseState) => {
        const state = finalizeLeague(baseState);

        const result = leaguePrize(state);
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        // Independent cross-check: the rank-1 rows of the league table.
        const table = buildLeagueTable(state);
        const expectedRankOneIds = new Set(
          table.filter((row) => row.rank === 1).map((row) => row.participantId),
        );

        const recipientIds = new Set(result.value.map((p) => p.id));

        // Same set of participants, no more and no fewer.
        expect(recipientIds).toEqual(expectedRankOneIds);
        // No duplicate recipients.
        expect(result.value.length).toBe(recipientIds.size);

        // Single recipient when the top is unique; all tied when shared.
        expect(result.value.length).toBe(expectedRankOneIds.size);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: worldcup-sweepstake, Property 41: League prize is unavailable until the table is finalized — for any state where the league table has not been finalized, requesting the League_Prize recipients returns a LEAGUE_NOT_FINALIZED status.
  // Validates: Requirements 8.5
  it("Property 41: league prize is unavailable (LEAGUE_NOT_FINALIZED) until the table is finalized", () => {
    fc.assert(
      fc.property(leagueStateArb, (state) => {
        // leagueStateArb always produces leagueFinalized === false.
        expect(state.leagueFinalized).toBe(false);

        const result = leaguePrize(state);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toEqual({ code: "LEAGUE_NOT_FINALIZED" });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
