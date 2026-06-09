// Match recording rules (pure).
//
// Encodes the rules for recording and updating match results. A match is
// identified by the unordered pair of nation ids {nationAId, nationBId}, so
// {A,B} and {B,A} refer to the same stored match. Recording validates that the
// two nations are distinct, both exist in the nation list, and that each goal
// count is an integer in 0..99. Updating replaces the goals of an existing
// stored pair, rejecting with MATCH_NOT_FOUND when no such pair is stored.
//
// Every rule function is pure: it takes the current state and returns either a
// new state (never mutating the input) or a typed DomainError. Stored matches
// are left unchanged on every rejection.

import {
  type DomainError,
  type Id,
  type Match,
  type Result,
  type SweepstakeState,
  err,
  ok,
} from "./types.js";

/** Smallest allowed goal count for a single nation in a match. */
export const MIN_GOALS = 0;
/** Largest allowed goal count for a single nation in a match. */
export const MAX_GOALS = 99;

/**
 * Input for recording or updating a match result. The orientation of A/B is
 * caller-supplied; identity is the unordered pair {nationAId, nationBId}.
 */
export interface MatchInput {
  nationAId: Id;
  nationBId: Id;
  /** Integer 0..99. */
  goalsA: number;
  /** Integer 0..99. */
  goalsB: number;
}

/**
 * Whether two nation ids form the same unordered pair as a stored match,
 * regardless of A/B orientation.
 */
function isSamePair(match: Match, nationAId: Id, nationBId: Id): boolean {
  return (
    (match.nationAId === nationAId && match.nationBId === nationBId) ||
    (match.nationAId === nationBId && match.nationBId === nationAId)
  );
}

/** Whether a goal count is an integer within the accepted 0..99 range. */
function isValidGoals(goals: number): boolean {
  return Number.isInteger(goals) && goals >= MIN_GOALS && goals <= MAX_GOALS;
}

/** Whether a nation id refers to a nation present in the state. */
function nationExists(state: SweepstakeState, nationId: Id): boolean {
  return state.nations.some((nation) => nation.id === nationId);
}

/**
 * Record a match result between two nations.
 *
 * Validates that the two nations are distinct, that both exist in the nation
 * list, and that each goal count is an integer in 0..99. The match is keyed by
 * the unordered nation pair; recording a pair that already has a stored result
 * replaces that result so the pair remains the unique key. On success returns a
 * new state in which the match is retrievable by its unordered nation pair with
 * the submitted goals.
 *
 * Rejections (stored matches unchanged):
 * - `NATIONS_NOT_DISTINCT` — both nations are the same.
 * - `UNKNOWN_NATION` — a referenced nation is not in the nation list (the error
 *   carries the unrecognized nation id).
 * - `GOALS_OUT_OF_RANGE` — a goal count is non-integer, less than 0, or greater
 *   than 99.
 */
export function recordMatch(
  state: SweepstakeState,
  input: MatchInput,
): Result<SweepstakeState, DomainError> {
  const { nationAId, nationBId, goalsA, goalsB } = input;

  if (nationAId === nationBId) {
    return err({ code: "NATIONS_NOT_DISTINCT" });
  }

  if (!nationExists(state, nationAId)) {
    return err({ code: "UNKNOWN_NATION", nation: nationAId });
  }
  if (!nationExists(state, nationBId)) {
    return err({ code: "UNKNOWN_NATION", nation: nationBId });
  }

  if (!isValidGoals(goalsA) || !isValidGoals(goalsB)) {
    return err({ code: "GOALS_OUT_OF_RANGE" });
  }

  const match: Match = { nationAId, nationBId, goalsA, goalsB };

  const exists = state.matches.some((stored) =>
    isSamePair(stored, nationAId, nationBId),
  );

  const matches = exists
    ? state.matches.map((stored) =>
        isSamePair(stored, nationAId, nationBId) ? match : stored,
      )
    : [...state.matches, match];

  return ok({ ...state, matches });
}

/**
 * Update the result of a previously stored match, identified by its unordered
 * nation pair.
 *
 * Locates the stored match whose unordered pair equals the input pair and
 * replaces its goal counts with the submitted values, leaving the number of
 * stored matches unchanged. The stored A/B orientation is preserved so the
 * match remains retrievable by the same pair.
 *
 * Rejections (stored matches unchanged):
 * - `MATCH_NOT_FOUND` — no stored match exists for the given nation pair.
 * - `GOALS_OUT_OF_RANGE` — a goal count is non-integer, less than 0, or greater
 *   than 99.
 */
export function updateMatch(
  state: SweepstakeState,
  input: MatchInput,
): Result<SweepstakeState, DomainError> {
  const { nationAId, nationBId, goalsA, goalsB } = input;

  const existing = state.matches.find((stored) =>
    isSamePair(stored, nationAId, nationBId),
  );
  if (existing === undefined) {
    return err({ code: "MATCH_NOT_FOUND" });
  }

  if (!isValidGoals(goalsA) || !isValidGoals(goalsB)) {
    return err({ code: "GOALS_OUT_OF_RANGE" });
  }

  // Preserve the stored orientation: map the submitted goals onto the stored
  // nationA/nationB so the pair stays retrievable unchanged.
  const updated: Match =
    existing.nationAId === nationAId
      ? { ...existing, goalsA, goalsB }
      : { ...existing, goalsA: goalsB, goalsB: goalsA };

  const matches = state.matches.map((stored) =>
    isSamePair(stored, nationAId, nationBId) ? updated : stored,
  );

  return ok({ ...state, matches });
}

/**
 * Delete a previously stored match result, identified by its unordered nation
 * pair.
 *
 * Removes the match whose unordered pair equals the input pair. On success
 * returns a new state with that match removed (one fewer stored match). Points
 * and standings recompute from the remaining matches automatically.
 *
 * Rejections (stored matches unchanged):
 * - `MATCH_NOT_FOUND` — no stored match exists for the given nation pair.
 */
export function deleteMatch(
  state: SweepstakeState,
  nationAId: Id,
  nationBId: Id,
): Result<SweepstakeState, DomainError> {
  const exists = state.matches.some((stored) =>
    isSamePair(stored, nationAId, nationBId),
  );
  if (!exists) {
    return err({ code: "MATCH_NOT_FOUND" });
  }
  const matches = state.matches.filter(
    (stored) => !isSamePair(stored, nationAId, nationBId),
  );
  return ok({ ...state, matches });
}

/**
 * Return the current list of recorded match results.
 *
 * Returns a shallow copy so callers cannot mutate the stored state through the
 * returned array.
 */
export function listMatches(state: SweepstakeState): Match[] {
  return [...state.matches];
}
