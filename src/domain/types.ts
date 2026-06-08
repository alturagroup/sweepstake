// Core data models and shared Result/error types for the domain core.
//
// These types are pure data definitions (no I/O, no behavior). They model the
// stored sweepstake state, the derived league table, and the typed-result /
// error shapes that every rule function returns instead of throwing.

/** Opaque unique identifier for participants, nations, etc. */
export type Id = string;

/**
 * A member of the team taking part in the sweepstake.
 *
 * `displayName` preserves the original (trimmed) name for presentation, while
 * `normalizedName` (lowercased + trimmed) is used for case-insensitive
 * uniqueness checks and ordering.
 */
export interface Participant {
  id: Id;
  /** Original, trimmed name. */
  displayName: string;
  /** Lowercased trimmed name, for uniqueness and sorting. */
  normalizedName: string;
}

/** A national team competing in the tournament being tracked. */
export interface Nation {
  id: Id;
  /** Original, trimmed name. */
  displayName: string;
  /** Lowercased trimmed name, for uniqueness and sorting. */
  normalizedName: string;
}

/**
 * A recorded link between exactly one nation and exactly one participant.
 * Each nation is assigned to exactly one participant; a participant may hold
 * many nations.
 */
export interface Assignment {
  nationId: Id;
  participantId: Id;
}

/**
 * A single game between two distinct nations with a final score for each.
 * Identity is the unordered pair `{nationAId, nationBId}` — `{A,B}` and `{B,A}`
 * refer to the same match.
 */
export interface Match {
  nationAId: Id;
  /** Distinct from `nationAId`. */
  nationBId: Id;
  /** Integer 0..99. */
  goalsA: number;
  /** Integer 0..99. */
  goalsB: number;
}

/**
 * The complete persisted state of a sweepstake. All derived values (points,
 * league table, prizes) are recomputed from this state on demand and never
 * stored.
 */
export interface SweepstakeState {
  participants: Participant[];
  nations: Nation[];
  /** Empty until an assignment is run. */
  assignments: Assignment[];
  /** Unordered nation pair is the unique key. */
  matches: Match[];
  championNationId: Id | null;
  leagueFinalized: boolean;
}

/**
 * A single row of the derived league table. Not stored; produced by
 * `buildLeagueTable`.
 */
export interface LeagueRow {
  participantId: Id;
  displayName: string;
  totalPoints: number;
  /** Count of participants with strictly greater points + 1. */
  rank: number;
}

/** Ordered by points descending, then case-insensitive name ascending. */
export type LeagueTable = LeagueRow[];

/**
 * Discriminated-union result type returned by all rule functions. Domain rule
 * violations are represented as `ok: false` values rather than thrown
 * exceptions, so every rejection path is explicit and state is left unchanged
 * on rejection.
 */
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/**
 * All domain rule violations, keyed by a stable `code` used for API status
 * mapping. Some variants carry contextual payloads (e.g. the unrecognized
 * nation name).
 */
export type DomainError =
  | { code: "NAME_REQUIRED" }
  | { code: "NAME_TOO_LONG" }
  | { code: "DUPLICATE_PARTICIPANT" }
  | { code: "DUPLICATE_NATION" }
  | { code: "ASSIGNMENTS_EXIST" }
  | { code: "PARTICIPANT_NOT_FOUND" }
  | { code: "NO_PARTICIPANTS" }
  | { code: "NO_NATIONS" }
  | { code: "CONFIRMATION_REQUIRED" }
  | { code: "UNKNOWN_NATION"; nation: string }
  | { code: "NATIONS_NOT_DISTINCT" }
  | { code: "GOALS_OUT_OF_RANGE" }
  | { code: "MATCH_NOT_FOUND" }
  | { code: "CHAMPION_NOT_ASSIGNED" }
  | { code: "CHAMPION_NOT_RECORDED" }
  | { code: "LEAGUE_NOT_FINALIZED" };

/**
 * Convenience constructor for a successful result.
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Convenience constructor for a failed result.
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}
