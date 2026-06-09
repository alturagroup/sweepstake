// Multi-league (multi-tenant) persistence over Neon Postgres.
//
// The single-tenant model stored one SweepstakeState. To support multiple
// independent sweepstake "leagues" that all track the SAME real-world
// tournament, storage is split in two:
//
//   - tournament_state (shared): the universal facts of the one tournament —
//     nations, recorded matches, and the champion. Entered once by the admin;
//     every league sees the same results.
//   - leagues (per-league): each league's own participants, random
//     assignments, finalized flag, plus its name, URL slug, and view password.
//
// A full SweepstakeState for a given league is COMPOSED at the service layer
// (shared tournament + that league's data), so the pure domain core runs
// unchanged. This module only does storage.

import { neon } from "@neondatabase/serverless";

import type { Assignment, Id, Match, Nation, Participant } from "../domain/types.js";

/** Shared, tournament-wide facts visible to every league. */
export interface TournamentState {
  nations: Nation[];
  matches: Match[];
  championNationId: Id | null;
}

/** A single sweepstake league (one group of friends/colleagues). */
export interface League {
  id: Id;
  /** URL-safe unique identifier, e.g. "work" or "friends". */
  slug: string;
  /** Human-readable display name. */
  name: string;
  /** Shared password required to view this league. Stored hashed. */
  viewPasswordHash: string;
  participants: Participant[];
  assignments: Assignment[];
  leagueFinalized: boolean;
}

/** A fresh, empty shared tournament. */
export function emptyTournament(): TournamentState {
  return { nations: [], matches: [], championNationId: null };
}

/**
 * Neon-backed multi-league store. Construct via {@link create} so the schema
 * is ensured up front.
 */
export class NeonLeagueRepository {
  private readonly sql: ReturnType<typeof neon>;

  constructor(connectionString: string) {
    if (!connectionString || connectionString.trim().length === 0) {
      throw new Error("A non-empty Neon connection string is required.");
    }
    this.sql = neon(connectionString);
  }

  static async create(connectionString: string): Promise<NeonLeagueRepository> {
    const repo = new NeonLeagueRepository(connectionString);
    await repo.ensureSchema();
    return repo;
  }

  /** Create the tournament + leagues tables if absent. Idempotent. */
  async ensureSchema(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS tournament_state (
        id INTEGER PRIMARY KEY,
        state JSONB NOT NULL
      )
    `;
    await this.sql`
      CREATE TABLE IF NOT EXISTS leagues (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        view_password_hash TEXT NOT NULL,
        participants JSONB NOT NULL DEFAULT '[]'::jsonb,
        assignments JSONB NOT NULL DEFAULT '[]'::jsonb,
        league_finalized BOOLEAN NOT NULL DEFAULT FALSE
      )
    `;
  }

  // --- Shared tournament --------------------------------------------------

  async loadTournament(): Promise<TournamentState> {
    const rows = (await this.sql`
      SELECT state FROM tournament_state WHERE id = 1
    `) as Array<{ state: TournamentState }>;
    return rows[0]?.state ?? emptyTournament();
  }

  async saveTournament(state: TournamentState): Promise<void> {
    await this.sql`
      INSERT INTO tournament_state (id, state)
      VALUES (1, ${JSON.stringify(state)})
      ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state
    `;
  }

  // --- Leagues ------------------------------------------------------------

  private static rowToLeague(row: {
    id: string;
    slug: string;
    name: string;
    view_password_hash: string;
    participants: Participant[];
    assignments: Assignment[];
    league_finalized: boolean;
  }): League {
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      viewPasswordHash: row.view_password_hash,
      participants: row.participants,
      assignments: row.assignments,
      leagueFinalized: row.league_finalized,
    };
  }

  async listLeagues(): Promise<League[]> {
    const rows = (await this.sql`
      SELECT id, slug, name, view_password_hash, participants, assignments, league_finalized
      FROM leagues ORDER BY name
    `) as Parameters<typeof NeonLeagueRepository.rowToLeague>[0][];
    return rows.map((r) => NeonLeagueRepository.rowToLeague(r));
  }

  async getLeagueBySlug(slug: string): Promise<League | null> {
    const rows = (await this.sql`
      SELECT id, slug, name, view_password_hash, participants, assignments, league_finalized
      FROM leagues WHERE slug = ${slug}
    `) as Parameters<typeof NeonLeagueRepository.rowToLeague>[0][];
    const row = rows[0];
    return row ? NeonLeagueRepository.rowToLeague(row) : null;
  }

  async insertLeague(league: League): Promise<void> {
    await this.sql`
      INSERT INTO leagues (id, slug, name, view_password_hash, participants, assignments, league_finalized)
      VALUES (
        ${league.id}, ${league.slug}, ${league.name}, ${league.viewPasswordHash},
        ${JSON.stringify(league.participants)}, ${JSON.stringify(league.assignments)},
        ${league.leagueFinalized}
      )
    `;
  }

  /** Persist the mutable per-league fields (participants/assignments/finalized). */
  async saveLeague(league: League): Promise<void> {
    await this.sql`
      UPDATE leagues SET
        name = ${league.name},
        view_password_hash = ${league.viewPasswordHash},
        participants = ${JSON.stringify(league.participants)},
        assignments = ${JSON.stringify(league.assignments)},
        league_finalized = ${league.leagueFinalized}
      WHERE id = ${league.id}
    `;
  }

  async deleteLeague(slug: string): Promise<void> {
    await this.sql`DELETE FROM leagues WHERE slug = ${slug}`;
  }
}
