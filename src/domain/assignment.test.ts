import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { type Rng, assign } from "./assignment.js";
import type {
  Assignment,
  Nation,
  Participant,
  SweepstakeState,
} from "./types.js";

// Property-based tests for the random assignment engine (Requirements 3.1–3.8).
//
// Properties 12–19 from the design document. Each test is tagged with the
// feature and property it validates. The engine takes an injected `Rng`, so a
// small seeded mulberry32 PRNG is implemented below to make the
// uniform-distribution sampling (Property 15) reproducible.

// ---------------------------------------------------------------------------
// Test fixtures & helpers
// ---------------------------------------------------------------------------

/** Build a participant with stable, unique ids derived from an index. */
function makeParticipant(i: number): Participant {
  return { id: `p${i}`, displayName: `Participant ${i}`, normalizedName: `participant ${i}` };
}

/** Build a nation with stable, unique ids derived from an index. */
function makeNation(i: number): Nation {
  return { id: `n${i}`, displayName: `Nation ${i}`, normalizedName: `nation ${i}` };
}

/** Build a full sweepstake state from the given pieces. */
function makeState(
  participants: Participant[],
  nations: Nation[],
  assignments: Assignment[] = [],
): SweepstakeState {
  return {
    participants,
    nations,
    assignments,
    matches: [],
    championNationId: null,
    leagueFinalized: false,
  };
}

/**
 * Minimal seeded PRNG (mulberry32) used to make sampling reproducible. Returns
 * a float in [0, 1) just like Math.random, satisfying the `Rng` contract.
 */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Count how many nations each participant received. */
function countsByParticipant(
  participants: Participant[],
  assignments: Assignment[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of participants) counts.set(p.id, 0);
  for (const a of assignments) {
    counts.set(a.participantId, (counts.get(a.participantId) ?? 0) + 1);
  }
  return counts;
}

/**
 * Canonical key for a distribution: nation->participant pairs sorted by nation
 * id. Two assignment results with the same nation->participant mapping yield
 * the same key regardless of array order.
 */
function distributionKey(pairs: Array<[string, string]>): string {
  return [...pairs]
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))
    .map(([n, p]) => `${n}:${p}`)
    .join("|");
}

function keyOfAssignments(assignments: Assignment[]): string {
  return distributionKey(
    assignments.map((a) => [a.nationId, a.participantId] as [string, string]),
  );
}

/**
 * Enumerate every valid distribution (Properties 12–14) of the given nations
 * across the given participants: each nation to exactly one participant with
 * per-participant counts balanced to within one.
 */
function enumerateValidDistributions(
  participants: Participant[],
  nations: Nation[],
): Set<string> {
  const m = participants.length;
  const k = nations.length;
  const valid = new Set<string>();
  const total = m ** k;
  for (let code = 0; code < total; code++) {
    let c = code;
    const counts = new Array<number>(m).fill(0);
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < k; i++) {
      const pi = c % m;
      c = Math.floor(c / m);
      counts[pi] = (counts[pi] as number) + 1;
      pairs.push([nations[i]!.id, participants[pi]!.id]);
    }
    const max = Math.max(...counts);
    const min = Math.min(...counts);
    if (max - min <= 1) {
      valid.add(distributionKey(pairs));
    }
  }
  return valid;
}

// Arbitrary for a non-empty list of distinct participants of length [min, max].
function participantsArb(min: number, max: number) {
  return fc
    .integer({ min, max })
    .map((n) => Array.from({ length: n }, (_, i) => makeParticipant(i)));
}

// Arbitrary for a non-empty list of distinct nations of length [min, max].
function nationsArb(min: number, max: number) {
  return fc
    .integer({ min, max })
    .map((n) => Array.from({ length: n }, (_, i) => makeNation(i)));
}

// Arbitrary for a non-empty list of pre-existing assignments (opaque ids).
const existingAssignmentsArb = fc.array(
  fc.record({
    nationId: fc.string({ minLength: 1, maxLength: 6 }),
    participantId: fc.string({ minLength: 1, maxLength: 6 }),
  }),
  { minLength: 1, maxLength: 10 },
);

/** Assert a successful assignment result satisfies the core validity rules. */
function expectValidAssignment(
  participants: Participant[],
  nations: Nation[],
  assignments: Assignment[],
): void {
  const nationIds = new Set(nations.map((n) => n.id));
  const participantIds = new Set(participants.map((p) => p.id));

  // Coverage: every nation assigned exactly once (Property 12).
  const assignedNationIds = assignments.map((a) => a.nationId);
  expect(assignedNationIds.length).toBe(nations.length);
  expect(new Set(assignedNationIds).size).toBe(nations.length);
  for (const id of assignedNationIds) expect(nationIds.has(id)).toBe(true);
  for (const a of assignments) expect(participantIds.has(a.participantId)).toBe(true);

  // Balance within one (Property 14, holds for all sizes).
  const counts = [...countsByParticipant(participants, assignments).values()];
  expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);

  // At least one each when nations >= participants (Property 13).
  if (nations.length >= participants.length) {
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(1);
  }
}

// ---------------------------------------------------------------------------
// Property 12
// ---------------------------------------------------------------------------

// Feature: worldcup-sweepstake, Property 12: Assignment covers every nation exactly once
describe("Property 12: assignment covers every nation exactly once", () => {
  it("assigns every nation to exactly one participant with none left out", () => {
    fc.assert(
      fc.property(
        participantsArb(1, 8),
        nationsArb(1, 14),
        fc.integer(),
        (participants, nations, seed) => {
          const state = makeState(participants, nations);
          const result = assign(state, mulberry32(seed), false);
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const assignedNationIds = result.value.assignments.map((a) => a.nationId);
          // Every nation appears exactly once.
          expect([...assignedNationIds].sort()).toEqual(
            nations.map((n) => n.id).sort(),
          );
          expect(new Set(assignedNationIds).size).toBe(nations.length);
          // No nation assigned to more than one participant (set of nation ids
          // equals the full nation set with no duplicates, asserted above).
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 13
// ---------------------------------------------------------------------------

// Feature: worldcup-sweepstake, Property 13: Every participant receives at least one nation when nations ≥ participants
describe("Property 13: every participant gets at least one nation when nations >= participants", () => {
  it("gives every participant at least one nation", () => {
    fc.assert(
      fc.property(
        // Ensure nations >= participants by deriving nation count from base.
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 12 }),
        fc.integer(),
        (participantCount, extra, seed) => {
          const participants = Array.from({ length: participantCount }, (_, i) =>
            makeParticipant(i),
          );
          const nationCount = participantCount + extra; // >= participantCount
          const nations = Array.from({ length: nationCount }, (_, i) =>
            makeNation(i),
          );
          const state = makeState(participants, nations);
          const result = assign(state, mulberry32(seed), false);
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const counts = countsByParticipant(participants, result.value.assignments);
          for (const p of participants) {
            expect(counts.get(p.id) ?? 0).toBeGreaterThanOrEqual(1);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 14
// ---------------------------------------------------------------------------

// Feature: worldcup-sweepstake, Property 14: Assignment is balanced to within one nation per participant
describe("Property 14: assignment balanced to within one when nations exceed participants", () => {
  it("keeps the largest and smallest per-participant count within one", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer(),
        (participantCount, surplus, seed) => {
          const participants = Array.from({ length: participantCount }, (_, i) =>
            makeParticipant(i),
          );
          // nations strictly greater than participants.
          const nationCount = participantCount + surplus;
          const nations = Array.from({ length: nationCount }, (_, i) =>
            makeNation(i),
          );
          const state = makeState(participants, nations);
          const result = assign(state, mulberry32(seed), false);
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const counts = [
            ...countsByParticipant(participants, result.value.assignments).values(),
          ];
          expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 15
// ---------------------------------------------------------------------------

// Feature: worldcup-sweepstake, Property 15: Assignment is uniformly distributed and order-independent
describe("Property 15: assignment is uniformly distributed and order-independent", () => {
  // Fixed small inputs: 2 participants, 3 nations -> 6 valid distributions.
  const participants = [makeParticipant(0), makeParticipant(1)];
  const nations = [makeNation(0), makeNation(1), makeNation(2)];
  const SAMPLES = 60_000;
  const TOLERANCE = 0.02; // absolute tolerance on observed proportions

  function sampleFrequencies(
    ps: Participant[],
    ns: Nation[],
    rng: Rng,
    samples: number,
  ): Map<string, number> {
    const freq = new Map<string, number>();
    const state = makeState(ps, ns);
    for (let i = 0; i < samples; i++) {
      const result = assign(state, rng, false);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const key = keyOfAssignments(result.value.assignments);
      freq.set(key, (freq.get(key) ?? 0) + 1);
    }
    return freq;
  }

  it("produces every valid distribution with empirically equal frequency", () => {
    const valid = enumerateValidDistributions(participants, nations);
    expect(valid.size).toBe(6);

    const rng = mulberry32(0x9e3779b9);
    const freq = sampleFrequencies(participants, nations, rng, SAMPLES);

    // Only valid distributions are produced, and all of them appear.
    expect(new Set(freq.keys())).toEqual(valid);

    const expected = 1 / valid.size;
    for (const key of valid) {
      const observed = (freq.get(key) ?? 0) / SAMPLES;
      expect(Math.abs(observed - expected)).toBeLessThan(TOLERANCE);
    }

    // Chi-square goodness-of-fit as a secondary check (df = 5).
    const expectedCount = SAMPLES / valid.size;
    let chiSquare = 0;
    for (const key of valid) {
      const obs = freq.get(key) ?? 0;
      chiSquare += (obs - expectedCount) ** 2 / expectedCount;
    }
    // Critical value for df=5 at p=0.001 is ~20.5; comfortably above typical
    // statistics for a uniform generator with a fixed seed.
    expect(chiSquare).toBeLessThan(20.5);
  });

  it("does not change the outcome distribution when participant/nation insertion order is permuted", () => {
    const baseRng = mulberry32(0x12345678);
    const baseFreq = sampleFrequencies(participants, nations, baseRng, SAMPLES);

    // Permute insertion order of both participants and nations.
    const permutedParticipants = [...participants].reverse();
    const permutedNations = [...nations].reverse();
    const permRng = mulberry32(0x0bad_c0de);
    const permFreq = sampleFrequencies(
      permutedParticipants,
      permutedNations,
      permRng,
      SAMPLES,
    );

    // Same set of valid outcomes regardless of insertion order.
    const valid = enumerateValidDistributions(participants, nations);
    expect(new Set(permFreq.keys())).toEqual(valid);

    // The distribution over outcomes is statistically the same.
    for (const key of valid) {
      const base = (baseFreq.get(key) ?? 0) / SAMPLES;
      const perm = (permFreq.get(key) ?? 0) / SAMPLES;
      expect(Math.abs(base - perm)).toBeLessThan(TOLERANCE);
    }
  });
});

// ---------------------------------------------------------------------------
// Property 16
// ---------------------------------------------------------------------------

// Feature: worldcup-sweepstake, Property 16: Assignment with no participants is rejected
describe("Property 16: assignment with no participants is rejected", () => {
  it("rejects with NO_PARTICIPANTS and leaves existing assignments unchanged", () => {
    fc.assert(
      fc.property(
        nationsArb(0, 10),
        existingAssignmentsArb,
        fc.integer(),
        (nations, existing, seed) => {
          const state = makeState([], nations, existing);
          const before = structuredClone(state.assignments);
          const result = assign(state, mulberry32(seed), false);

          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("NO_PARTICIPANTS");
          // Input state left unchanged.
          expect(state.assignments).toEqual(before);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 17
// ---------------------------------------------------------------------------

// Feature: worldcup-sweepstake, Property 17: Assignment with no nations is rejected
describe("Property 17: assignment with no nations is rejected", () => {
  it("rejects with NO_NATIONS and leaves existing assignments unchanged", () => {
    fc.assert(
      fc.property(
        participantsArb(1, 8),
        existingAssignmentsArb,
        fc.integer(),
        (participants, existing, seed) => {
          const state = makeState(participants, [], existing);
          const before = structuredClone(state.assignments);
          const result = assign(state, mulberry32(seed), false);

          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("NO_NATIONS");
          expect(state.assignments).toEqual(before);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 18
// ---------------------------------------------------------------------------

// Feature: worldcup-sweepstake, Property 18: Re-assignment without confirmation is rejected
describe("Property 18: re-assignment without confirmation is rejected", () => {
  it("rejects with CONFIRMATION_REQUIRED and leaves existing assignments unchanged", () => {
    fc.assert(
      fc.property(
        participantsArb(1, 8),
        nationsArb(1, 10),
        existingAssignmentsArb,
        fc.integer(),
        (participants, nations, existing, seed) => {
          const state = makeState(participants, nations, existing);
          const before = structuredClone(state.assignments);
          const result = assign(state, mulberry32(seed), false);

          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error.code).toBe("CONFIRMATION_REQUIRED");
          expect(state.assignments).toEqual(before);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 19
// ---------------------------------------------------------------------------

// Feature: worldcup-sweepstake, Property 19: Confirmed re-assignment replaces existing assignments
describe("Property 19: confirmed re-assignment replaces existing assignments", () => {
  it("discards previous assignments and still satisfies Properties 12–14", () => {
    fc.assert(
      fc.property(
        participantsArb(1, 8),
        nationsArb(1, 14),
        existingAssignmentsArb,
        fc.integer(),
        (participants, nations, existing, seed) => {
          const state = makeState(participants, nations, existing);
          const result = assign(state, mulberry32(seed), true);

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // The previous (arbitrary) assignments are discarded: the new set
          // references only the real nation/participant ids and satisfies the
          // validity rules from Properties 12–14.
          expectValidAssignment(participants, nations, result.value.assignments);
        },
      ),
      { numRuns: 200 },
    );
  });
});
