// Domain Core (pure functions and immutable value objects).
// Rule logic lives here: name validation, assignment engine, match recording,
// scoring, league table, and prize determination. No I/O.

export type {
  Id,
  Participant,
  Nation,
  Assignment,
  Match,
  SweepstakeState,
  LeagueRow,
  LeagueTable,
  Result,
  DomainError,
} from "./types.js";
export { ok, err } from "./types.js";
export { normalizeName, validateName, MAX_NAME_LENGTH } from "./names.js";
