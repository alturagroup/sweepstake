// Random assignment engine (pure).
//
// Distributes every nation among the participants so that the result is a
// uniformly random valid distribution: each nation is assigned to exactly one
// participant, every nation is assigned, and the per-participant nation counts
// are balanced to within one. The distribution is independent of the insertion
// order of participants and nations.
//
// Randomness is injected as an `Rng` function so production can supply a
// seeded PRNG while tests inject deterministic or statistically analyzable
// sources. Every rule function is pure: it takes the current state and returns
// either a new state (never mutating the input) or a typed DomainError, leaving
// state unchanged on every rejection.

import {
  type Assignment,
  type DomainError,
  type Nation,
  type Participant,
  type Result,
  type SweepstakeState,
  err,
  ok,
} from "./types.js";

/**
 * Injected source of randomness. Returns a floating-point number in the
 * half-open interval `[0, 1)`, matching the contract of `Math.random`.
 *
 * Production wires a seeded PRNG; tests inject deterministic or
 * statistically analyzable sources so the uniform-distribution requirement is
 * reproducible and testable.
 */
export type Rng = () => number;

/**
 * A participant together with the nations currently assigned to them. Produced
 * by {@link listAssignments} for presentation (Requirement 3.9).
 */
export interface ParticipantAssignment {
  participant: Participant;
  nations: Nation[];
}

/**
 * Draw a uniformly distributed integer in `[0, n)` from the injected RNG.
 *
 * `rng()` yields a float in `[0, 1)`, so scaling by `n` and flooring maps it
 * onto `0..n-1`. The result is clamped to guard against an RNG that returns a
 * value at or above 1 due to floating-point rounding.
 */
function randomInt(rng: Rng, n: number): number {
  const value = Math.floor(rng() * n);
  return value < n ? value : n - 1;
}

/**
 * Return a new array containing the elements of `items` in a uniformly random
 * order, using the Fisher-Yates (Knuth) shuffle driven by the injected RNG.
 *
 * The shuffle is unbiased: every permutation of the input is equally likely
 * given a uniform RNG. The input array is not mutated.
 */
function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    const tmp = result[i] as T;
    result[i] = result[j] as T;
    result[j] = tmp;
  }
  return result;
}

/**
 * Randomly assign every nation to a participant.
 *
 * Produces a uniformly random valid distribution where:
 * - every nation is assigned to exactly one participant and none is left
 *   unassigned (Requirement 3.1);
 * - when nations ≥ participants, every participant receives at least one
 *   nation (Requirement 3.2);
 * - per-participant nation counts differ by at most one (Requirement 3.3);
 * - every valid distribution is equally likely and the outcome does not depend
 *   on the insertion order of participants or nations (Requirement 3.4).
 *
 * Uniformity is achieved by independently shuffling both the participant and
 * nation lists with an unbiased Fisher-Yates shuffle, assigning the surplus
 * (`nations mod participants`) one-nation bonus to the first participants in
 * the shuffled order, then dealing the shuffled nations into the resulting
 * count buckets. Shuffling both lists makes every valid labeled assignment the
 * image of an equal number of (participant-permutation, nation-permutation)
 * pairs, so all valid distributions occur with equal probability regardless of
 * input order.
 *
 * On success the returned state's `assignments` are replaced wholesale,
 * discarding any prior assignments (Requirement 3.8).
 *
 * Rejections (state unchanged):
 * - `NO_PARTICIPANTS` — the participant list is empty (Requirement 3.5).
 * - `NO_NATIONS` — the nation list is empty (Requirement 3.6).
 * - `CONFIRMATION_REQUIRED` — assignments already exist and `confirmReplace`
 *   was not set (Requirement 3.7).
 */
export function assign(
  state: SweepstakeState,
  rng: Rng,
  confirmReplace: boolean,
): Result<SweepstakeState, DomainError> {
  if (state.participants.length === 0) {
    return err({ code: "NO_PARTICIPANTS" });
  }

  if (state.nations.length === 0) {
    return err({ code: "NO_NATIONS" });
  }

  if (state.assignments.length > 0 && !confirmReplace) {
    return err({ code: "CONFIRMATION_REQUIRED" });
  }

  const participants = shuffle(state.participants, rng);
  const nations = shuffle(state.nations, rng);

  const participantCount = participants.length;
  const nationCount = nations.length;
  const base = Math.floor(nationCount / participantCount);
  const remainder = nationCount % participantCount;

  const assignments: Assignment[] = [];
  let nationIndex = 0;
  for (let p = 0; p < participantCount; p++) {
    const participant = participants[p] as Participant;
    // The first `remainder` shuffled participants receive one extra nation so
    // counts stay balanced to within one.
    const count = base + (p < remainder ? 1 : 0);
    for (let k = 0; k < count; k++) {
      assignments.push({
        nationId: (nations[nationIndex] as Nation).id,
        participantId: participant.id,
      });
      nationIndex++;
    }
  }

  return ok({
    ...state,
    assignments,
  });
}

/**
 * Return the current assignments grouped by participant, including each
 * participant and the nations assigned to them (Requirement 3.9).
 *
 * Every participant in the state is included, in the order they appear in the
 * participant list, even if they currently hold no nations (their `nations`
 * array is empty). The returned structures are fresh so callers cannot mutate
 * stored state through them.
 */
export function listAssignments(
  state: SweepstakeState,
): ParticipantAssignment[] {
  const nationsById = new Map<string, Nation>(
    state.nations.map((nation) => [nation.id, nation]),
  );

  const nationsByParticipant = new Map<string, Nation[]>(
    state.participants.map((participant) => [participant.id, []]),
  );

  for (const assignment of state.assignments) {
    const nation = nationsById.get(assignment.nationId);
    const bucket = nationsByParticipant.get(assignment.participantId);
    if (nation !== undefined && bucket !== undefined) {
      bucket.push(nation);
    }
  }

  return state.participants.map((participant) => ({
    participant,
    nations: nationsByParticipant.get(participant.id) ?? [],
  }));
}
