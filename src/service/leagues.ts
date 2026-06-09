// Multi-league application service.
//
// Composes a full SweepstakeState from the shared tournament plus one league's
// data, runs the unchanged pure domain core, then writes results back to the
// correct store (tournament-wide changes -> tournament_state; league-specific
// changes -> that league row). This keeps the property-tested core intact while
// supporting many independent leagues over one shared tournament.

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { type Rng, assign, listAssignments } from "../domain/assignment.js";
import { buildLeagueTable } from "../domain/league.js";
import {
  type MatchInput,
  listMatches,
  recordMatch,
  updateMatch,
} from "../domain/matches.js";
import { addNation, listNations, removeNation } from "../domain/nations.js";
import { addParticipant, removeParticipant } from "../domain/participants.js";
import {
  finalizeLeague,
  leaguePrize,
  recordChampion,
  tournamentWinner,
} from "../domain/prizes.js";
import type {
  DomainError,
  Id,
  Result,
  SweepstakeState,
} from "../domain/types.js";
import {
  type League,
  type NeonLeagueRepository,
  type TournamentState,
} from "../persistence/leagues.js";

/** Error returned when a league slug does not resolve. */
export interface LeagueNotFound { code: "LEAGUE_NOT_FOUND"; }
/** Error returned when a slug is already taken or invalid. */
export interface SlugError { code: "INVALID_SLUG" | "DUPLICATE_SLUG"; }

/** Hash a view password with a per-password random salt (salt:hash hex). */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(`${salt}:${password}`).digest("hex");
  return `${salt}:${hash}`;
}

/** Constant-time verification of a password against a stored salt:hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const [salt, expected] = stored.split(":");
  if (!salt || !expected) return false;
  const actual = createHash("sha256").update(`${salt}:${password}`).digest("hex");
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Normalize a requested slug to lowercase URL-safe form, or null if invalid. */
function normalizeSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase().replace(/\s+/g, "-");
  return /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/.test(slug) ? slug : null;
}

export class LeagueService {
  private readonly repo: NeonLeagueRepository;
  private readonly rng: Rng;

  constructor(repo: NeonLeagueRepository, rng: Rng) {
    this.repo = repo;
    this.rng = rng;
  }

  /**
   * Compose a full SweepstakeState from the shared tournament and one league,
   * so a pure domain function can operate on it unchanged.
   */
  private compose(t: TournamentState, l: League): SweepstakeState {
    return {
      participants: l.participants,
      nations: t.nations,
      assignments: l.assignments,
      matches: t.matches,
      championNationId: t.championNationId,
      leagueFinalized: l.leagueFinalized,
    };
  }

  // --- Shared tournament management (global admin) ------------------------

  async addNation(rawName: string): Promise<Result<unknown, DomainError>> {
    const t = await this.repo.loadTournament();
    const state = this.compose(t, emptyLeagueShell());
    const result = addNation(state, rawName);
    if (result.ok) {
      await this.repo.saveTournament({ ...t, nations: result.value.nations });
    }
    return result;
  }

  async removeNation(nationId: Id): Promise<Result<unknown, DomainError>> {
    // Nation removal is blocked once ANY league has assignments.
    const leagues = await this.repo.listLeagues();
    const anyAssigned = leagues.some((l) => l.assignments.length > 0);
    const t = await this.repo.loadTournament();
    const shell = anyAssigned
      ? { ...emptyLeagueShell(), assignments: [{ nationId, participantId: "x" }] }
      : emptyLeagueShell();
    const state = this.compose(t, shell);
    const result = removeNation(state, nationId);
    if (result.ok) {
      await this.repo.saveTournament({ ...t, nations: result.value.nations });
    }
    return result;
  }

  async listNations() {
    const t = await this.repo.loadTournament();
    return listNations(this.compose(t, emptyLeagueShell()));
  }

  async recordMatch(input: MatchInput): Promise<Result<unknown, DomainError>> {
    const t = await this.repo.loadTournament();
    const result = recordMatch(this.compose(t, emptyLeagueShell()), input);
    if (result.ok) await this.repo.saveTournament({ ...t, matches: result.value.matches });
    return result;
  }

  async updateMatch(input: MatchInput): Promise<Result<unknown, DomainError>> {
    const t = await this.repo.loadTournament();
    const result = updateMatch(this.compose(t, emptyLeagueShell()), input);
    if (result.ok) await this.repo.saveTournament({ ...t, matches: result.value.matches });
    return result;
  }

  async listMatches() {
    const t = await this.repo.loadTournament();
    return listMatches(this.compose(t, emptyLeagueShell()));
  }

  async recordChampion(nationId: Id): Promise<Result<unknown, DomainError | LeagueNotFound>> {
    // A champion must be assigned in at least one league to be valid here; we
    // validate existence against the shared nations, and assignment against the
    // union of all league assignments.
    const t = await this.repo.loadTournament();
    const leagues = await this.repo.listLeagues();
    const allAssignments = leagues.flatMap((l) => l.assignments);
    const state = this.compose(t, { ...emptyLeagueShell(), assignments: allAssignments });
    const result = recordChampion(state, nationId);
    if (result.ok) {
      await this.repo.saveTournament({ ...t, championNationId: result.value.championNationId });
    }
    return result;
  }

  // --- League lifecycle (global admin) ------------------------------------

  async createLeague(
    name: string,
    requestedSlug: string,
    viewPassword: string,
  ): Promise<Result<League, SlugError>> {
    const slug = normalizeSlug(requestedSlug);
    if (slug === null) return { ok: false, error: { code: "INVALID_SLUG" } };
    const existing = await this.repo.getLeagueBySlug(slug);
    if (existing) return { ok: false, error: { code: "DUPLICATE_SLUG" } };
    const league: League = {
      id: randomUUID(),
      slug,
      name: name.trim() || slug,
      viewPasswordHash: hashPassword(viewPassword),
      participants: [],
      assignments: [],
      leagueFinalized: false,
    };
    await this.repo.insertLeague(league);
    return { ok: true, value: league };
  }

  async listLeagues(): Promise<Array<{ slug: string; name: string; participantCount: number; assigned: boolean }>> {
    const leagues = await this.repo.listLeagues();
    return leagues.map((l) => ({
      slug: l.slug,
      name: l.name,
      participantCount: l.participants.length,
      assigned: l.assignments.length > 0,
    }));
  }

  async deleteLeague(slug: string): Promise<void> {
    await this.repo.deleteLeague(slug);
  }

  // --- Per-league operations (global admin) -------------------------------

  private async withLeague<T>(
    slug: string,
    fn: (t: TournamentState, l: League) => Promise<T> | T,
  ): Promise<T | LeagueNotFound> {
    const l = await this.repo.getLeagueBySlug(slug);
    if (!l) return { code: "LEAGUE_NOT_FOUND" };
    const t = await this.repo.loadTournament();
    return fn(t, l);
  }

  async addParticipant(slug: string, rawName: string) {
    return this.withLeague(slug, async (t, l) => {
      const result = addParticipant(this.compose(t, l), rawName);
      if (result.ok) await this.repo.saveLeague({ ...l, participants: result.value.participants });
      return result;
    });
  }

  async removeParticipant(slug: string, participantId: Id) {
    return this.withLeague(slug, async (t, l) => {
      const result = removeParticipant(this.compose(t, l), participantId);
      if (result.ok) await this.repo.saveLeague({ ...l, participants: result.value.participants });
      return result;
    });
  }

  async assign(slug: string, confirmReplace = false) {
    return this.withLeague(slug, async (t, l) => {
      const result = assign(this.compose(t, l), this.rng, confirmReplace);
      if (result.ok) await this.repo.saveLeague({ ...l, assignments: result.value.assignments });
      return result;
    });
  }

  async finalize(slug: string) {
    return this.withLeague(slug, async (t, l) => {
      const finalized = finalizeLeague(this.compose(t, l));
      await this.repo.saveLeague({ ...l, leagueFinalized: finalized.leagueFinalized });
      return { ok: true as const };
    });
  }

  // --- Per-league reads (public, used by the league view) -----------------

  async getView(slug: string) {
    return this.withLeague(slug, (t, l) => {
      const state = this.compose(t, l);
      return {
        name: l.name,
        slug: l.slug,
        leagueTable: buildLeagueTable(state),
        assignments: listAssignments(state),
        matches: listMatches(state),
        championRecorded: state.championNationId !== null,
        tournamentWinner: toNullable(tournamentWinner(state)),
        leagueFinalized: state.leagueFinalized,
        leaguePrize: toNullable(leaguePrize(state)),
      };
    });
  }

  /** Verify a viewer's password for a league. */
  async checkPassword(slug: string, password: string): Promise<boolean | LeagueNotFound> {
    const l = await this.repo.getLeagueBySlug(slug);
    if (!l) return { code: "LEAGUE_NOT_FOUND" };
    return verifyPassword(password, l.viewPasswordHash);
  }
}

/** A minimal empty league used when composing tournament-only operations. */
function emptyLeagueShell(): League {
  return {
    id: "",
    slug: "",
    name: "",
    viewPasswordHash: "",
    participants: [],
    assignments: [],
    leagueFinalized: false,
  };
}

/** Unwrap a Result to its value or null, for read endpoints. */
function toNullable<T>(r: Result<T, DomainError>): T | null {
  return r.ok ? r.value : null;
}
