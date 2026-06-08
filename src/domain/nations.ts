// Nation rules (pure).
//
// Encodes the rules for maintaining the nation list: adding a nation with
// shared name validation and case-insensitive, whitespace-insensitive
// uniqueness; removing a nation (allowed only before assignments exist); and
// reading the current nation list.
//
// Every rule function is pure: it takes the current state and returns either a
// new state (never mutating the input) or a typed DomainError. State is left
// unchanged on every rejection.

import { normalizeName, validateName } from "./names.js";
import {
  type DomainError,
  type Id,
  type Nation,
  type Result,
  type SweepstakeState,
  err,
  ok,
} from "./types.js";

/**
 * Generate a fresh opaque identifier for a new nation.
 *
 * Uses the platform crypto UUID generator so identifiers are unique without a
 * caller-supplied counter. Isolated here so the id strategy can change without
 * touching the rule logic.
 */
function newId(): Id {
  return crypto.randomUUID();
}

/**
 * Add a nation to the state.
 *
 * Validates the raw name against the shared naming rules (1–100 characters
 * after trimming) and enforces case-insensitive, whitespace-insensitive
 * uniqueness against existing nations. On success returns a new state with
 * exactly one additional nation whose `displayName` is the trimmed input and
 * whose `normalizedName` is its normalized form.
 *
 * Rejections (state unchanged):
 * - `NAME_REQUIRED` — empty or whitespace-only name.
 * - `NAME_TOO_LONG` — trimmed name exceeds the maximum length.
 * - `DUPLICATE_NATION` — normalized name matches an existing nation.
 */
export function addNation(
  state: SweepstakeState,
  rawName: string,
): Result<SweepstakeState, DomainError> {
  const validation = validateName(rawName);
  if (!validation.ok) {
    return validation;
  }

  const displayName = validation.value;
  const normalizedName = normalizeName(displayName);

  const isDuplicate = state.nations.some(
    (nation) => nation.normalizedName === normalizedName,
  );
  if (isDuplicate) {
    return err({ code: "DUPLICATE_NATION" });
  }

  const nation: Nation = {
    id: newId(),
    displayName,
    normalizedName,
  };

  return ok({
    ...state,
    nations: [...state.nations, nation],
  });
}

/**
 * Remove a nation from the state by id.
 *
 * A nation may only be removed before any assignments have been generated. On
 * success returns a new state whose nation list no longer contains the nation.
 * Removal is idempotent: removing an id that is not present succeeds and leaves
 * the nation list unchanged (no dedicated not-found error is defined for
 * nations).
 *
 * Rejections (state unchanged):
 * - `ASSIGNMENTS_EXIST` — assignments have been generated; removal is blocked.
 */
export function removeNation(
  state: SweepstakeState,
  nationId: Id,
): Result<SweepstakeState, DomainError> {
  if (state.assignments.length > 0) {
    return err({ code: "ASSIGNMENTS_EXIST" });
  }

  return ok({
    ...state,
    nations: state.nations.filter((nation) => nation.id !== nationId),
  });
}

/**
 * Return the current list of nations.
 *
 * Returns a shallow copy so callers cannot mutate the stored state through the
 * returned array.
 */
export function listNations(state: SweepstakeState): Nation[] {
  return [...state.nations];
}
