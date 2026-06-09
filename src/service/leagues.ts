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
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length >= 1 && s.length <= 40 ? s : null;
}

/** Generate a short, unguessable URL token (random hex). */
function urlToken(): string {
  return randomBytes(6).toString("hex"); // 12 hex chars
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
   *
   * When the league restricts its nation pool (`includedNationIds`), only those
   * nations are exposed. This scopes the random draw to the chosen subset (e.g.
   * the top 10 teams) while scoring still works because it sums over each
   * participant's assigned nations using the shared match set.
   */
  private compose(t: TournamentState, l: League): SweepstakeState {
    const nations =
      l.includedNationIds === null
        ? t.nations
        : t.nations.filter((n) => l.includedNationIds?.includes(n.id));
    return {
      participants: l.participants,
      nations,
      assignments: l.assignments,
      matches: t.matches,
      championNationId: t.championNationId,
      leagueFinalized: l.leagueFinalized,
    };
  }

  /**
   * Set (or clear) the nations a league draws from. Pass `null` to allow all
   * tournament nations. Rejected once the league already has assignments, since
   * changing the pool after the draw would invalidate it.
   */
  async setIncludedNations(
    slug: string,
    nationIds: Id[] | null,
  ): Promise<Result<unknown, DomainError> | LeagueNotFound> {
    return this.withLeague(slug, async (_t, l) => {
      if (l.assignments.length > 0) {
        return { ok: false as const, error: { code: "ASSIGNMENTS_EXIST" } as DomainError };
      }
      await this.repo.saveLeague({ ...l, includedNationIds: nationIds });
      return { ok: true as const, value: undefined };
    });
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
    const base = normalizeSlug(requestedSlug) || normalizeSlug(name) || "league";
    if (base === null) return { ok: false, error: { code: "INVALID_SLUG" } };
    // Append an unguessable random token so the URL itself acts as the secret.
    // Retry on the (astronomically unlikely) event of a collision.
    let slug = `${base}-${urlToken()}`;
    for (let i = 0; i < 5 && (await this.repo.getLeagueBySlug(slug)); i++) {
      slug = `${base}-${urlToken()}`;
    }
    // Password is optional: empty means the unguessable link alone grants access.
    const hasPassword = viewPassword.trim().length > 0;
    const league: League = {
      id: randomUUID(),
      slug,
      name: name.trim() || base,
      viewPasswordHash: hasPassword ? hashPassword(viewPassword) : "",
      participants: [],
      assignments: [],
      leagueFinalized: false,
      includedNationIds: null,
    };
    await this.repo.insertLeague(league);
    return { ok: true, value: league };
  }

  async listLeagues(): Promise<Array<{ slug: string; name: string; participantCount: number; assigned: boolean; nationPool: number | null }>> {
    const leagues = await this.repo.listLeagues();
    return leagues.map((l) => ({
      slug: l.slug,
      name: l.name,
      participantCount: l.participants.length,
      assigned: l.assignments.length > 0,
      nationPool: l.includedNationIds === null ? null : l.includedNationIds.length,
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

  /** Verify a viewer's password for a league. A league with no password set is always viewable. */
  async checkPassword(slug: string, password: string): Promise<boolean | LeagueNotFound> {
    const l = await this.repo.getLeagueBySlug(slug);
    if (!l) return { code: "LEAGUE_NOT_FOUND" };
    if (l.viewPasswordHash === "") return true; // no password: link is the secret
    return verifyPassword(password, l.viewPasswordHash);
  }

  /** Whether a league requires a password to view (false if link-only). */
  async requiresPassword(slug: string): Promise<boolean | LeagueNotFound> {
    const l = await this.repo.getLeagueBySlug(slug);
    if (!l) return { code: "LEAGUE_NOT_FOUND" };
    return l.viewPasswordHash !== "";
  }

  /** Admin: a league's current settings (its nation pool), for the settings UI. */
  async getSettings(slug: string): Promise<{ includedNationIds: Id[] | null; assigned: boolean } | LeagueNotFound> {
    const l = await this.repo.getLeagueBySlug(slug);
    if (!l) return { code: "LEAGUE_NOT_FOUND" };
    return { includedNationIds: l.includedNationIds, assigned: l.assignments.length > 0 };
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
    includedNationIds: null,
  };
}

/** Unwrap a Result to its value or null, for read endpoints. */
function toNullable<T>(r: Result<T, DomainError>): T | null {
  return r.ok ? r.value : null;
}
