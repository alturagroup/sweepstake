// Application Service Layer.
//
// Orchestrates the pure domain core against the persistence boundary and
// exposes the system's use cases to the interface layer. Each command use case
// follows the same shape: load the current state, call the corresponding pure
// core function, persist the new state ONLY when the typed Result is
// `ok: true`, and return the typed Result (or derived value) to the caller.
// Because rejections never persist, a rejected operation structurally leaves
// the stored document unchanged (Requirements 1.2, 1.6, 3.7, 4.7, 7.x).
//
// Read use cases (lists, league table, prize lookups) simply load the current
// state and derive their answer; they never write. Lifecycle flags
// (assignments exist, champion recorded, league finalized) are likewise derived
// from the loaded state.

import {
  type ParticipantAssignment,
  type Rng,
  assign,
  listAssignments,
} from "../domain/assignment.js";
import { buildLeagueTable } from "../domain/league.js";
import {
  type MatchInput,
  listMatches,
  recordMatch,
  updateMatch,
} from "../domain/matches.js";
import { addNation, listNations, removeNation } from "../domain/nations.js";
import {
  addParticipant,
  listParticipants,
  removeParticipant,
} from "../domain/participants.js";
import {
  finalizeLeague,
  leaguePrize,
  recordChampion,
  tournamentWinner,
} from "../domain/prizes.js";
import type {
  DomainError,
  Id,
  LeagueTable,
  Match,
  Nation,
  Participant,
  Result,
  SweepstakeState,
} from "../domain/types.js";
import type { SweepstakeRepository } from "../persistence/index.js";

/**
 * Lifecycle flags derived from the current sweepstake state. These let the
 * interface layer enable/disable actions (e.g. block participant removal once
 * assignments exist) without re-deriving the rules itself.
 */
export interface LifecycleFlags {
  /** True once an assignment has been generated (gates participant/nation removal). */
  assignmentsExist: boolean;
  /** True once a tournament champion has been recorded. */
  championRecorded: boolean;
  /** True once the league table has been finalized. */
  leagueFinalized: boolean;
}

/**
 * Application service that wires the pure domain core over a persistence
 * boundary.
 *
 * Construction takes the repository used for load/save and an injected `Rng`
 * passed to the assignment engine. Keeping randomness injected (rather than
 * calling `Math.random` internally) preserves the testability and
 * reproducibility of the assignment distribution.
 *
 * Every method is asynchronous because persistence I/O is asynchronous.
 * Command methods persist only on success; read methods never persist.
 */
export class SweepstakeService {
  private readonly repository: SweepstakeRepository;
  private readonly rng: Rng;

  constructor(repository: SweepstakeRepository, rng: Rng) {
    this.repository = repository;
    this.rng = rng;
  }

  /**
   * Apply a pure command function to the current state and persist the new
   * state only when the function succeeds.
   *
   * Loads the current state, invokes `apply`, and on `ok: true` saves the
   * resulting state before returning the success result. On `ok: false` the
   * stored document is left untouched and the typed error is returned as-is.
   */
  private async runCommand(
    apply: (state: SweepstakeState) => Result<SweepstakeState, DomainError>,
  ): Promise<Result<SweepstakeState, DomainError>> {
    const state = await this.repository.load();
    const result = apply(state);
    if (result.ok) {
      await this.repository.save(result.value);
    }
    return result;
  }

  // --- Participants -------------------------------------------------------

  /**
   * Add a participant by raw name. Persists on success.
   * _Requirements: 1.1_
   */
  async addParticipant(
    rawName: string,
  ): Promise<Result<SweepstakeState, DomainError>> {
    return this.runCommand((state) => addParticipant(state, rawName));
  }

  /**
   * Remove a participant by id. Rejected (state unchanged) when assignments
   * exist or the participant is not found. Persists on success.
   * _Requirements: 1.5_
   */
  async removeParticipant(
    participantId: Id,
  ): Promise<Result<SweepstakeState, DomainError>> {
    return this.runCommand((state) => removeParticipant(state, participantId));
  }

  /** Return the current participant list. */
  async listParticipants(): Promise<Participant[]> {
    const state = await this.repository.load();
    return listParticipants(state);
  }

  // --- Nations ------------------------------------------------------------

  /**
   * Add a nation by raw name. Persists on success.
   * _Requirements: 2.1_
   */
  async addNation(
    rawName: string,
  ): Promise<Result<SweepstakeState, DomainError>> {
    return this.runCommand((state) => addNation(state, rawName));
  }

  /**
   * Remove a nation by id. Rejected (state unchanged) when assignments exist.
   * Persists on success.
   * _Requirements: 2.4_
   */
  async removeNation(
    nationId: Id,
  ): Promise<Result<SweepstakeState, DomainError>> {
    return this.runCommand((state) => removeNation(state, nationId));
  }

  /** Return the current nation list. */
  async listNations(): Promise<Nation[]> {
    const state = await this.repository.load();
    return listNations(state);
  }

  // --- Assignment ---------------------------------------------------------

  /**
   * Run (or, with `confirmReplace`, replace) the random assignment using the
   * injected RNG. Rejected (state unchanged) with `NO_PARTICIPANTS`,
   * `NO_NATIONS`, or `CONFIRMATION_REQUIRED`. Persists on success.
   * _Requirements: 3.1, 3.8_
   */
  async assign(
    confirmReplace = false,
  ): Promise<Result<SweepstakeState, DomainError>> {
    return this.runCommand((state) => assign(state, this.rng, confirmReplace));
  }

  /** Return the current assignments grouped by participant. */
  async listAssignments(): Promise<ParticipantAssignment[]> {
    const state = await this.repository.load();
    return listAssignments(state);
  }

  // --- Matches ------------------------------------------------------------

  /**
   * Record a match result. Rejected (stored matches unchanged) on
   * `NATIONS_NOT_DISTINCT`, `UNKNOWN_NATION`, or `GOALS_OUT_OF_RANGE`.
   * Persists on success.
   * _Requirements: 4.1_
   */
  async recordMatch(
    input: MatchInput,
  ): Promise<Result<SweepstakeState, DomainError>> {
    return this.runCommand((state) => recordMatch(state, input));
  }

  /**
   * Update an existing match's result, identified by its unordered nation
   * pair. Rejected (stored matches unchanged) on `MATCH_NOT_FOUND` or
   * `GOALS_OUT_OF_RANGE`. Persists on success.
   * _Requirements: 4.5_
   */
  async updateMatch(
    input: MatchInput,
  ): Promise<Result<SweepstakeState, DomainError>> {
    return this.runCommand((state) => updateMatch(state, input));
  }

  /** Return the current list of recorded matches. */
  async listMatches(): Promise<Match[]> {
    const state = await this.repository.load();
    return listMatches(state);
  }

  // --- League table -------------------------------------------------------

  /**
   * Return the current league table, derived from all stored matches at the
   * time of the request.
   */
  async getLeagueTable(): Promise<LeagueTable> {
    const state = await this.repository.load();
    return buildLeagueTable(state);
  }

  // --- Prizes -------------------------------------------------------------

  /**
   * Record the tournament champion nation. Rejected (state unchanged) on
   * `UNKNOWN_NATION` or `CHAMPION_NOT_ASSIGNED`; replaces any previously
   * recorded champion. Persists on success.
   * _Requirements: 7.1, 7.4_
   */
  async recordChampion(
    nationId: Id,
  ): Promise<Result<SweepstakeState, DomainError>> {
    return this.runCommand((state) => recordChampion(state, nationId));
  }

  /**
   * Return the Tournament_Winner_Prize recipient, or `CHAMPION_NOT_RECORDED`
   * until a champion has been recorded. Read-only.
   */
  async getTournamentWinner(): Promise<Result<Participant, DomainError>> {
    const state = await this.repository.load();
    return tournamentWinner(state);
  }

  /**
   * Finalize the league table so the League_Prize becomes available. Persists
   * the finalized state.
   * _Requirements: 8.1_
   */
  async finalizeLeague(): Promise<SweepstakeState> {
    const state = await this.repository.load();
    const finalized = finalizeLeague(state);
    await this.repository.save(finalized);
    return finalized;
  }

  /**
   * Return the League_Prize recipient(s) — every rank-1 participant — or
   * `LEAGUE_NOT_FINALIZED` until the table has been finalized. Read-only.
   */
  async getLeaguePrize(): Promise<Result<Participant[], DomainError>> {
    const state = await this.repository.load();
    return leaguePrize(state);
  }

  // --- Lifecycle flags ----------------------------------------------------

  /**
   * Derive the lifecycle flags from the current state: whether assignments
   * exist, whether a champion has been recorded, and whether the league has
   * been finalized.
   */
  async getLifecycleFlags(): Promise<LifecycleFlags> {
    const state = await this.repository.load();
    return {
      assignmentsExist: state.assignments.length > 0,
      championRecorded: state.championNationId !== null,
      leagueFinalized: state.leagueFinalized,
    };
  }
}
