// Scoring rules (pure).
//
// Encodes how points are derived from stored match results. Nothing is cached:
// both a nation's total and a participant's total are recomputed from the
// current `matches` array (and the current assignments) on every call, so any
// add/update/remove of a match automatically yields correct recalculated
// totals (Requirement 5.6).
//
// Scoring rules (per match, Requirements 5.1–5.3):
// - The nation with the strictly higher goal count earns 3 win/draw points; the
//   other earns 0.
// - On a draw (equal goal counts) each nation earns 1 win/draw point.
// - Each nation additionally earns goal points equal to its own goal count.
//
// A nation's total (5.4) is the sum of win/draw plus goal points across every
// match it played. A participant's total (5.5) is the arithmetic sum over the
// nations assigned to that participant, and is 0 when none of those nations have
// any stored match results.

import { type Id, type Match, type SweepstakeState } from "./types.js";

/**
 * Win/draw points awarded to a single nation for one match, given that nation's
 * goal count (`own`) and the opponent's goal count (`other`).
 *
 * - 3 points when the nation scored strictly more than the opponent (a win).
 * - 1 point when the goal counts are equal (a draw).
 * - 0 points when the nation scored strictly fewer (a loss).
 */
function winDrawPointsFor(own: number, other: number): number {
  if (own > other) {
    return 3;
  }
  if (own === other) {
    return 1;
  }
  return 0;
}

/**
 * Points a nation earns from a single match it participated in: its win/draw
 * points plus goal points equal to its own goal count. Returns 0 if the nation
 * did not participate in the match (so callers can sum unconditionally).
 */
function matchPointsForNation(match: Match, nationId: Id): number {
  if (match.nationAId === nationId) {
    return winDrawPointsFor(match.goalsA, match.goalsB) + match.goalsA;
  }
  if (match.nationBId === nationId) {
    return winDrawPointsFor(match.goalsB, match.goalsA) + match.goalsB;
  }
  return 0;
}

/**
 * Total points for a nation across the supplied matches.
 *
 * Sums, over every match in which the nation participated, that nation's
 * win/draw points (Requirements 5.1, 5.2) plus its goal points (Requirement
 * 5.3). A nation that appears in no match scores 0. Derived purely from the
 * given `matches`; nothing is cached (Requirement 5.4, 5.6).
 */
export function nationPoints(matches: Match[], nationId: Id): number {
  return matches.reduce(
    (total, match) => total + matchPointsForNation(match, nationId),
    0,
  );
}

/**
 * Total points for a participant: the arithmetic sum of the total points of
 * every nation assigned to that participant, computed from the current match
 * set (Requirement 5.5).
 *
 * Reports 0 when the participant has no assigned nations or when none of their
 * assigned nations have any stored match results. A participant id with no
 * assignments simply contributes nothing. Derived purely from current state;
 * nothing is cached (Requirement 5.6).
 */
export function participantPoints(
  state: SweepstakeState,
  participantId: Id,
): number {
  return state.assignments
    .filter((assignment) => assignment.participantId === participantId)
    .reduce(
      (total, assignment) =>
        total + nationPoints(state.matches, assignment.nationId),
      0,
    );
}
