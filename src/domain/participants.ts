// Participant rules (pure).
//
// Encodes the rules for maintaining the participant list: adding a participant
// with shared name validation and case-insensitive, whitespace-insensitive
// uniqueness; removing a participant (allowed only before assignments exist and
// only when the participant exists); and reading the current participant list.
//
// Every rule function is pure: it takes the current state and returns either a
// new state (never mutating the input) or a typed DomainError. State is left
// unchanged on every rejection.

import { normalizeName, validateName } from "./names.js";
import {
  type DomainError,
  type Id,
  type Participant,
  type Result,
  type SweepstakeState,
  err,
  ok,
} from "./types.js";

/**
 * Generate a fresh opaque identifier for a new participant.
 *
 * Uses the platform crypto UUID generator so identifiers are unique without a
 * caller-supplied counter. Isolated here so the id strategy can change without
 * touching the rule logic.
 */
function newId(): Id {
  return crypto.randomUUID();
}

/**
 * Add a participant to the state.
 *
 * Validates the raw name against the shared naming rules (1–100 characters
 * after trimming) and enforces case-insensitive, whitespace-insensitive
 * uniqueness against existing participants. On success returns a new state with
 * exactly one additional participant whose `displayName` is the trimmed input
 * and whose `normalizedName` is its normalized form.
 *
 * Rejections (state unchanged):
 * - `NAME_REQUIRED` — empty or whitespace-only name.
 * - `NAME_TOO_LONG` — trimmed name exceeds the maximum length.
 * - `DUPLICATE_PARTICIPANT` — normalized name matches an existing participant.
 */
export function addParticipant(
  state: SweepstakeState,
  rawName: string,
): Result<SweepstakeState, DomainError> {
  const validation = validateName(rawName);
  if (!validation.ok) {
    return validation;
  }

  const displayName = validation.value;
  const normalizedName = normalizeName(displayName);

  const isDuplicate = state.participants.some(
    (participant) => participant.normalizedName === normalizedName,
  );
  if (isDuplicate) {
    return err({ code: "DUPLICATE_PARTICIPANT" });
  }

  const participant: Participant = {
    id: newId(),
    displayName,
    normalizedName,
  };

  return ok({
    ...state,
    participants: [...state.participants, participant],
  });
}

/**
 * Remove a participant from the state by id.
 *
 * A participant may only be removed before any assignments have been generated.
 * On success returns a new state whose participant list no longer contains the
 * participant and is exactly one shorter.
 *
 * Rejections (state unchanged):
 * - `PARTICIPANT_NOT_FOUND` — no participant with the given id exists.
 * - `ASSIGNMENTS_EXIST` — assignments have been generated; removal is blocked.
 */
export function removeParticipant(
  state: SweepstakeState,
  participantId: Id,
): Result<SweepstakeState, DomainError> {
  const exists = state.participants.some(
    (participant) => participant.id === participantId,
  );
  if (!exists) {
    return err({ code: "PARTICIPANT_NOT_FOUND" });
  }

  if (state.assignments.length > 0) {
    return err({ code: "ASSIGNMENTS_EXIST" });
  }

  return ok({
    ...state,
    participants: state.participants.filter(
      (participant) => participant.id !== participantId,
    ),
  });
}

/**
 * Return the current list of participants.
 *
 * Returns a shallow copy so callers cannot mutate the stored state through the
 * returned array.
 */
export function listParticipants(state: SweepstakeState): Participant[] {
  return [...state.participants];
}
