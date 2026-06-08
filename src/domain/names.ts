// Name normalization and validation (pure).
//
// Participant and Nation names share the same identity and validation rules:
// they are compared case-insensitively after trimming surrounding whitespace,
// and must be 1–100 characters long once trimmed. These helpers are the single
// source of truth for both rules so participant and nation logic stay
// consistent.

import { type DomainError, type Result, err, ok } from "./types.js";

/** Maximum allowed name length, measured after trimming. */
export const MAX_NAME_LENGTH = 100;

/**
 * Normalize a raw name for comparison and storage as `normalizedName`:
 * trim surrounding whitespace, then lowercase. Used for case-insensitive,
 * whitespace-insensitive uniqueness checks and ordering.
 */
export function normalizeName(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * Validate a raw name against the shared naming rules.
 *
 * Returns the trimmed display form on success. On failure returns:
 * - `NAME_REQUIRED` when the name is empty or whitespace-only after trimming.
 * - `NAME_TOO_LONG` when the trimmed name exceeds {@link MAX_NAME_LENGTH}.
 *
 * The returned value is the trimmed name (preserving original case) suitable
 * for use as `displayName`; callers derive `normalizedName` via
 * {@link normalizeName}.
 */
export function validateName(
  raw: string,
): Result<string, DomainError> {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return err({ code: "NAME_REQUIRED" });
  }

  if (trimmed.length > MAX_NAME_LENGTH) {
    return err({ code: "NAME_TOO_LONG" });
  }

  return ok(trimmed);
}
