// League table construction and ranking (pure).
//
// Derives the ranked league table from the current sweepstake state. Nothing is
// cached: each row's total points are recomputed from the current match set via
// `participantPoints`, so the table always reflects all stored match results at
// the time of the request (Requirements 6.7, 5.6).
//
// Ranking rules (Requirements 6.1–6.6):
// - One row per participant in the participant list, carrying that
//   participant's total points (6.1).
// - Rows are ordered by total points from highest to lowest (6.2).
// - Tied participants (equal total points) are ordered among themselves in
//   ascending case-insensitive name order (6.3).
// - Each participant's rank equals the count of participants with strictly
//   greater total points plus 1, so tied participants share the same rank
//   (6.4, 6.5).
// - An empty participant list yields an empty table (6.6).

import { participantPoints } from "./scoring.js";
import {
  type LeagueRow,
  type LeagueTable,
  type SweepstakeState,
} from "./types.js";

/**
 * Build the ranked league table for the given state.
 *
 * Produces exactly one row per participant, each carrying that participant's
 * total points computed from the current match set. Rows are ordered by total
 * points descending and, among participants with equal points, by ascending
 * case-insensitive name. Each row's rank is the number of participants with
 * strictly greater total points plus 1, so tied participants share a rank.
 *
 * Returns an empty table when the participant list is empty. The function is
 * pure: it reads only the supplied state and never mutates it.
 */
export function buildLeagueTable(state: SweepstakeState): LeagueTable {
  // Compute each participant's total points from the current match set.
  const rows: LeagueRow[] = state.participants.map((participant) => ({
    participantId: participant.id,
    displayName: participant.displayName,
    totalPoints: participantPoints(state, participant.id),
    // Rank = count of participants with strictly greater total points + 1.
    rank: 0,
  }));

  // Assign ranks: strictly-greater point counts define the rank position, so
  // participants with equal points receive the same rank.
  for (const row of rows) {
    const strictlyGreater = rows.filter(
      (other) => other.totalPoints > row.totalPoints,
    ).length;
    row.rank = strictlyGreater + 1;
  }

  // Order by points descending, then by case-insensitive name ascending.
  rows.sort((a, b) => {
    if (b.totalPoints !== a.totalPoints) {
      return b.totalPoints - a.totalPoints;
    }
    return a.displayName.localeCompare(b.displayName, undefined, {
      sensitivity: "base",
    });
  });

  return rows;
}

/**
 * Return the current league table.
 *
 * The table is derived on demand from the current state, so it always reflects
 * all stored match results at the time of the request (Requirement 6.7).
 */
export function getLeagueTable(state: SweepstakeState): LeagueTable {
  return buildLeagueTable(state);
}
