// Property-based tests for the participant rules (src/domain/participants.ts).
//
// Each test maps one-to-one to a correctness property from the design document
// and is tagged with a traceability comment in the format:
//   // Feature: worldcup-sweepstake, Property {n}: {property_text}
//
// All properties run a minimum of 100 generated cases ({ numRuns: 100 }).

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { normalizeName } from "./names.js";
import { addParticipant, removeParticipant } from "./participants.js";
import type { Assignment, Participant, SweepstakeState } from "./types.js";

const NUM_RUNS = 100;

// --- Helpers -----------------------------------------------------------------

/** Build a clean state with the given participants and (optionally) assignments. */
function baseState(
  participants: Participant[],
  assignments: Assignment[] = [],
): SweepstakeState {
  return {
    participants,
    nations: [],
    assignments,
    matches: [],
    championNationId: null,
    leagueFinalized: false,
  };
}

/** Build a participant from an already-trimmed canonical name. */
function makeParticipant(name: string, id: string): Participant {
  return { id, displayName: name, normalizedName: normalizeName(name) };
}

// --- Arbitraries -------------------------------------------------------------

// ASCII-safe characters so that case-folding never changes string length
// (avoids locale edge cases like the German "ß"). Includes letters, digits,
// internal spaces, hyphen and underscore.
const nameChar = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_".split(
    "",
  ),
);

/** Whitespace runs used to build leading/trailing padding variants. */
const whitespace = fc.stringOf(fc.constantFrom(" ", "\t", "\n", "\r"), {
  maxLength: 4,
});

/**
 * A canonical name: no leading/trailing whitespace, trimmed length 1–100.
 * This is the "content" of a name; surrounding whitespace is added separately.
 */
const canonicalName = fc
  .array(nameChar, { minLength: 1, maxLength: 100 })
  .map((chars) => chars.join("").trim())
  .filter((s) => s.length >= 1 && s.length <= 100);

/** A canonical name whose trimmed length strictly exceeds 100 (101–200). */
const overLengthName = fc
  .array(nameChar.filter((c) => c.trim().length === 1), {
    minLength: 101,
    maxLength: 200,
  })
  .map((chars) => chars.join(""))
  .filter((s) => s.trim().length > 100);

/** Produce a random-case rendering of the given name. */
function caseVariantArb(name: string): fc.Arbitrary<string> {
  return fc
    .array(fc.boolean(), { minLength: name.length, maxLength: name.length })
    .map((flags) =>
      name
        .split("")
        .map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join(""),
    );
}

/**
 * Produce a case + surrounding-whitespace variant of a name whose normalized
 * form is identical to `normalizeName(name)`.
 */
function variantOfArb(name: string): fc.Arbitrary<string> {
  return fc
    .tuple(whitespace, caseVariantArb(name), whitespace)
    .map(([lead, body, trail]) => `${lead}${body}${trail}`);
}

/** A list of participants unique by normalized name, each with a unique id. */
function participantsArb(minLength: number) {
  return fc
    .uniqueArray(canonicalName, {
      selector: (n) => normalizeName(n),
      minLength,
      maxLength: 8,
    })
    .map((names) => names.map((n, i) => makeParticipant(n, `p${i}`)));
}

/** State with no assignments. */
const stateNoAssignmentsArb = participantsArb(0).map((ps) => baseState(ps));

/** State that has at least one participant and at least one assignment. */
const stateWithAssignmentsArb = participantsArb(1).chain((participants) =>
  fc
    .array(
      fc.record({
        nationId: fc.string({ minLength: 1 }),
        participantId: fc.constantFrom(...participants.map((p) => p.id)),
      }),
      { minLength: 1, maxLength: 5 },
    )
    .map((assignments) => baseState(participants, assignments)),
);

/** Either kind of state (with or without assignments). */
const anyStateArb = fc.oneof(stateNoAssignmentsArb, stateWithAssignmentsArb);

// --- Tests -------------------------------------------------------------------

describe("addParticipant / removeParticipant properties", () => {
  // Feature: worldcup-sweepstake, Property 1: Valid participant is added — For any state and any name that, after trimming, has length 1–100 and does not case-insensitively match an existing participant, adding the participant succeeds and yields a participant list that is exactly one longer and contains the normalized name.
  it("Property 1: adds a valid, non-duplicate participant", () => {
    // Pair a non-empty state with a candidate name (in case/whitespace variant
    // form) that does not collide with any existing participant.
    const stateAndCandidate = stateNoAssignmentsArb.chain((state) =>
      canonicalName
        .filter(
          (name) =>
            !state.participants.some(
              (p) => p.normalizedName === normalizeName(name),
            ),
        )
        .chain((name) =>
          fc
            .oneof(fc.constant(name), variantOfArb(name))
            .map((rawName) => ({ state, name, rawName })),
        ),
    );

    fc.assert(
      fc.property(stateAndCandidate, ({ state, name, rawName }) => {
        const normalized = normalizeName(name);
        const result = addParticipant(state, rawName);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.participants).toHaveLength(
          state.participants.length + 1,
        );
        expect(
          result.value.participants.some(
            (p) => p.normalizedName === normalized,
          ),
        ).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: worldcup-sweepstake, Property 2: Duplicate participant names are rejected (case-insensitive, trimmed) — For any state containing a participant and for any name that equals that participant's name after trimming and case-folding (including differing case and surrounding whitespace), adding it is rejected with DUPLICATE_PARTICIPANT and the participant list is unchanged.
  it("Property 2: rejects duplicate participant names (case/whitespace insensitive)", () => {
    // Pick an existing participant and produce a case/whitespace variant of its
    // name that normalizes to the same value.
    const stateAndDuplicate = stateWithAssignmentsArb.chain((state) =>
      fc
        .constantFrom(...state.participants)
        .chain((target) =>
          variantOfArb(target.displayName).map((rawName) => ({
            state,
            rawName,
          })),
        ),
    );

    fc.assert(
      fc.property(stateAndDuplicate, ({ state, rawName }) => {
        const before = state.participants;
        const result = addParticipant(state, rawName);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toEqual({ code: "DUPLICATE_PARTICIPANT" });
        // List unchanged.
        expect(state.participants).toBe(before);
        expect(state.participants).toHaveLength(before.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: worldcup-sweepstake, Property 3: Empty or whitespace participant names are rejected — For any string consisting solely of whitespace (including the empty string), adding it as a participant is rejected with NAME_REQUIRED and the participant list is unchanged.
  it("Property 3: rejects empty/whitespace-only participant names", () => {
    const whitespaceOnly = fc.stringOf(
      fc.constantFrom(" ", "\t", "\n", "\r"),
      { maxLength: 10 },
    );
    fc.assert(
      fc.property(stateNoAssignmentsArb, whitespaceOnly, (state, rawName) => {
        const before = state.participants;
        const result = addParticipant(state, rawName);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toEqual({ code: "NAME_REQUIRED" });
        expect(state.participants).toBe(before);
        expect(state.participants).toHaveLength(before.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: worldcup-sweepstake, Property 4: Over-length participant names are rejected — For any string whose length after trimming exceeds 100, adding it as a participant is rejected with NAME_TOO_LONG and the participant list is unchanged.
  it("Property 4: rejects over-length participant names", () => {
    fc.assert(
      fc.property(
        stateNoAssignmentsArb,
        overLengthName,
        whitespace,
        whitespace,
        (state, content, lead, trail) => {
          const rawName = `${lead}${content}${trail}`;
          const before = state.participants;
          const result = addParticipant(state, rawName);
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error).toEqual({ code: "NAME_TOO_LONG" });
          expect(state.participants).toHaveLength(before.length);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: worldcup-sweepstake, Property 5: Participant removal before assignments succeeds — For any state with no assignments and any existing participant, removing that participant yields a list that no longer contains them and is one shorter.
  it("Property 5: removes an existing participant when no assignments exist", () => {
    fc.assert(
      fc.property(
        participantsArb(1).map((ps) => baseState(ps)),
        fc.nat(),
        (state, pick) => {
          const target = state.participants[pick % state.participants.length];
          const result = removeParticipant(state, target.id);
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.value.participants).toHaveLength(
            state.participants.length - 1,
          );
          expect(
            result.value.participants.some((p) => p.id === target.id),
          ).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: worldcup-sweepstake, Property 6: Participant removal after assignments is rejected — For any state in which assignments exist and any participant, removing that participant is rejected with ASSIGNMENTS_EXIST and the participant list is unchanged.
  it("Property 6: rejects removal when assignments exist", () => {
    fc.assert(
      fc.property(stateWithAssignmentsArb, fc.nat(), (state, pick) => {
        const target = state.participants[pick % state.participants.length];
        const before = state.participants;
        const result = removeParticipant(state, target.id);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toEqual({ code: "ASSIGNMENTS_EXIST" });
        expect(state.participants).toBe(before);
        expect(state.participants).toHaveLength(before.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  // Feature: worldcup-sweepstake, Property 7: Removing a non-existent participant is rejected — For any state and any id not present in the participant list, removal is rejected with PARTICIPANT_NOT_FOUND and the participant list is unchanged.
  it("Property 7: rejects removal of a non-existent participant id", () => {
    fc.assert(
      fc.property(
        anyStateArb,
        fc.string({ minLength: 1 }),
        (state, id) => {
          fc.pre(!state.participants.some((p) => p.id === id));
          const before = state.participants;
          const result = removeParticipant(state, id);
          expect(result.ok).toBe(false);
          if (result.ok) return;
          expect(result.error).toEqual({ code: "PARTICIPANT_NOT_FOUND" });
          expect(state.participants).toBe(before);
          expect(state.participants).toHaveLength(before.length);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
