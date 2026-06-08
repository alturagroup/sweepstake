// Prize determination and league finalization (pure).
//
// Encodes the rules for the two prizes:
//
// - Tournament_Winner_Prize: the participant assigned the recorded Champion
//   nation. A champion may only be recorded when the nation exists and is
//   currently assigned to a participant; recording a new champion replaces any
//   previously recorded one.
// - League_Prize: the participant(s) holding rank position 1 in the league
//   table, available only once the league table has been finalized.
//
// Every rule function is pure: it takes the current state and returns either a
// new state / derived value (never mutating the input) or a typed DomainError.
// State is left unchanged on every rejection.
//
// To avoid coupling to concurrently developed scoring / league-table modules,
// participant point totals are computed by a small local helper rather than
// imported. This keeps the prize rules self-contained; the production league
// table builder computes the same totals independently.

import {
  type DomainError,
  type Id,
  type Match,
  type Participant,
  type Result,
  type SweepstakeState,
  err,
  ok,
} from "./types.js";

/**
 * Compute a single nation's total points across all stored matches.
 *
 * Scoring rules (Requirements 5.1–5.4):
 * - The higher scorer in a match receives 3 win/draw points; the lower scorer
 *   receives 0.
 * - On a draw each nation receives 1 win/draw point.
 * - Each nation additionally receives goal points equal to its goal count.
 *
 * Local to this module so prize logic does not depend on the scoring module.
 */
function nationPoints(matches: Match[], nationId: Id): number {
  let total = 0;

  for (const match of matches) {
    const isA = match.nationAId === nationId;
    const isB = match.nationBId === nationId;
    if (!isA && !isB) {
      continue;
    }

    const own = isA ? match.goalsA : match.goalsB;
    const other = isA ? match.goalsB : match.goalsA;

    if (own > other) {
      total += 3;
    } else if (own === other) {
      total += 1;
    }

    total += own;
  }

  return total;
}

/**
 * Compute a participant's total points: the sum of the total points of every
 * nation assigned to that participant. Participants whose assigned nations have
 * no stored results (or who hold no nations) total 0 (Requirement 5.5).
 *
 * Local to this module to keep the prize rules self-contained.
 */
function participantPoints(
  state: SweepstakeState,
  participantId: Id,
): number {
  return state.assignments
    .filter((assignment) => assignment.participantId === participantId)
    .reduce(
      (sum, assignment) => sum + nationPoints(state.matches, assignment.nationId),
      0,
    );
}

/**
 * Record the tournament Champion nation.
 *
 * The nation must exist in the nation list and must currently be assigned to a
 * participant. Recording a champion when one has already been recorded replaces
 * the previous champion (Requirement 7.4).
 *
 * Rejections (state unchanged):
 * - `UNKNOWN_NATION` — the nation id is not in the nation list (the
 *   unrecognized nation's display name, or the raw id when not found, is
 *   included in the error payload).
 * - `CHAMPION_NOT_ASSIGNED` — the nation exists but has no assignment.
 *
 * On success returns a new state whose `championNationId` is the given nation.
 *
 * _Requirements: 7.1, 7.2, 7.3, 7.4_
 */
export function recordChampion(
  state: SweepstakeState,
  nationId: Id,
): Result<SweepstakeState, DomainError> {
  const nation = state.nations.find((candidate) => candidate.id === nationId);
  if (nation === undefined) {
    return err({ code: "UNKNOWN_NATION", nation: nationId });
  }

  const isAssigned = state.assignments.some(
    (assignment) => assignment.nationId === nationId,
  );
  if (!isAssigned) {
    return err({ code: "CHAMPION_NOT_ASSIGNED" });
  }

  return ok({
    ...state,
    championNationId: nationId,
  });
}

/**
 * Determine the Tournament_Winner_Prize recipient: the participant assigned the
 * recorded Champion nation.
 *
 * Returns the single holding participant on success. Because a champion can
 * only be recorded while it is assigned (see {@link recordChampion}), an
 * assignment for the recorded champion always exists.
 *
 * Rejections:
 * - `CHAMPION_NOT_RECORDED` — no champion has been recorded yet.
 *
 * _Requirements: 7.1, 7.5, 7.6_
 */
export function tournamentWinner(
  state: SweepstakeState,
): Result<Participant, DomainError> {
  if (state.championNationId === null) {
    return err({ code: "CHAMPION_NOT_RECORDED" });
  }

  const assignment = state.assignments.find(
    (candidate) => candidate.nationId === state.championNationId,
  );
  // Defensive: a recorded champion is guaranteed assigned by recordChampion,
  // but assignments could have been replaced afterwards.
  if (assignment === undefined) {
    return err({ code: "CHAMPION_NOT_ASSIGNED" });
  }

  const participant = state.participants.find(
    (candidate) => candidate.id === assignment.participantId,
  );
  if (participant === undefined) {
    return err({ code: "PARTICIPANT_NOT_FOUND" });
  }

  return ok(participant);
}

/**
 * Finalize the league table so the League_Prize becomes available.
 *
 * Idempotent: finalizing an already-finalized state returns an equivalent
 * finalized state. Returns a new state with `leagueFinalized` set to `true`.
 *
 * _Requirements: 8.1_
 */
export function finalizeLeague(state: SweepstakeState): SweepstakeState {
  return {
    ...state,
    leagueFinalized: true,
  };
}

/**
 * Determine the League_Prize recipient(s): every participant holding rank
 * position 1 in the league table, i.e. those with the maximum total points.
 *
 * Returns a single participant when the top score is unique and all tied
 * participants when the top is shared (Requirements 8.2, 8.3). Recipients are
 * returned in case-insensitive ascending name order to match league-table
 * tie ordering.
 *
 * Rejections:
 * - `LEAGUE_NOT_FINALIZED` — the league table has not been finalized.
 *
 * _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
 */
export function leaguePrize(
  state: SweepstakeState,
): Result<Participant[], DomainError> {
  if (!state.leagueFinalized) {
    return err({ code: "LEAGUE_NOT_FINALIZED" });
  }

  if (state.participants.length === 0) {
    return ok([]);
  }

  const totals = state.participants.map((participant) => ({
    participant,
    points: participantPoints(state, participant.id),
  }));

  const maxPoints = Math.max(...totals.map((entry) => entry.points));

  const recipients = totals
    .filter((entry) => entry.points === maxPoints)
    .map((entry) => entry.participant)
    .sort((a, b) => a.normalizedName.localeCompare(b.normalizedName));

  return ok(recipients);
}
