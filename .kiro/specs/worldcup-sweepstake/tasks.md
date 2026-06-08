# Implementation Plan: World Cup Sweepstake

## Overview

This plan implements the World Cup Sweepstake as a TypeScript/Node.js application with a pure domain core, an application service layer over a persistence boundary, and an HTTP API. Work proceeds bottom-up: project setup and shared types first, then the pure domain core (validation, participant/nation rules, assignment engine, match recorder, scoring, league table, prizes), followed by persistence, the service layer, the HTTP API, and finally end-to-end wiring. Property-based tests (fast-check) are placed next to each domain component they validate, mapping one-to-one to the 41 correctness properties in the design.

## Tasks

- [x] 1. Set up project structure, tooling, and shared types
  - [x] 1.1 Initialize TypeScript project and test tooling
    - Create the Node.js + TypeScript project (`package.json`, `tsconfig.json`) with strict mode enabled
    - Add and configure the test runner (Vitest or Jest) and the `fast-check` property-testing library
    - Create the source directory structure: `src/domain`, `src/service`, `src/api`, `src/persistence`, and matching test folders
    - _Requirements: 1.1, 2.1, 3.1, 4.1, 5.1, 6.1, 7.1, 8.1_

  - [x] 1.2 Define core data models and Result/error types
    - Implement `Id`, `Participant`, `Nation`, `Assignment`, `Match`, `SweepstakeState`, `LeagueRow`, and `LeagueTable` interfaces
    - Implement the generic `Result<T, E>` discriminated union and the `DomainError` union with all error codes from the design
    - _Requirements: 1.2, 1.3, 1.4, 2.2, 2.3, 3.5, 3.6, 3.7, 4.2, 4.3, 4.4, 4.6, 7.2, 7.3, 7.6, 8.5_

- [x] 2. Implement name validation and participant rules
  - [x] 2.1 Implement name normalization and validation
    - Implement `normalizeName(raw)` (trim + lowercase) and `validateName(raw)` enforcing 1–100 chars after trimming, returning `NAME_REQUIRED` / `NAME_TOO_LONG`
    - _Requirements: 1.1, 1.3, 1.4, 2.1, 2.3_

  - [x] 2.2 Implement participant add and remove rules
    - Implement `addParticipant(state, rawName)` with validation and case-insensitive trimmed uniqueness
    - Implement `removeParticipant(state, participantId)` rejecting when assignments exist (`ASSIGNMENTS_EXIST`) or participant missing (`PARTICIPANT_NOT_FOUND`); allow removal before assignments
    - Implement the participant list getter
    - _Requirements: 1.1, 1.2, 1.5, 1.6, 1.7, 1.8_

  - [x] 2.3 Write property test for valid participant addition
    - **Property 1: Valid participant is added**
    - **Validates: Requirements 1.1**

  - [x] 2.4 Write property test for duplicate participant rejection
    - **Property 2: Duplicate participant names are rejected (case-insensitive, trimmed)**
    - **Validates: Requirements 1.2**

  - [x] 2.5 Write property test for empty/whitespace participant names
    - **Property 3: Empty or whitespace participant names are rejected**
    - **Validates: Requirements 1.3**

  - [x] 2.6 Write property test for over-length participant names
    - **Property 4: Over-length participant names are rejected**
    - **Validates: Requirements 1.4**

  - [x] 2.7 Write property test for participant removal before assignments
    - **Property 5: Participant removal before assignments succeeds**
    - **Validates: Requirements 1.5**

  - [x] 2.8 Write property test for participant removal after assignments
    - **Property 6: Participant removal after assignments is rejected**
    - **Validates: Requirements 1.6**

  - [x] 2.9 Write property test for removing a non-existent participant
    - **Property 7: Removing a non-existent participant is rejected**
    - **Validates: Requirements 1.7**

- [x] 3. Implement nation rules
  - [x] 3.1 Implement nation add and remove rules
    - Implement `addNation(state, rawName)` with validation and case-insensitive trimmed uniqueness (`DUPLICATE_NATION`)
    - Implement `removeNation(state, nationId)` allowed only before assignments exist
    - Implement the nation list getter
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 3.2 Write property test for valid nation addition
    - **Property 8: Valid nation is added**
    - **Validates: Requirements 2.1**

  - [x] 3.3 Write property test for duplicate nation rejection
    - **Property 9: Duplicate nation names are rejected (case-insensitive, trimmed)**
    - **Validates: Requirements 2.2**

  - [x] 3.4 Write property test for invalid nation names
    - **Property 10: Invalid nation names are rejected**
    - **Validates: Requirements 2.3**

  - [x] 3.5 Write property test for nation removal before assignments
    - **Property 11: Nation removal before assignments succeeds**
    - **Validates: Requirements 2.4**

- [x] 4. Implement the random assignment engine
  - [x] 4.1 Implement fair assignment with injected RNG
    - Implement `assign(state, rng, confirmReplace)` producing a uniformly random valid distribution: every nation assigned exactly once, balanced to within 1 per participant, order-independent
    - Handle lifecycle rejections: `NO_PARTICIPANTS`, `NO_NATIONS`, `CONFIRMATION_REQUIRED`, and confirmed replacement of existing assignments
    - Implement the assignments getter (each participant and their assigned nations)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_

  - [x] 4.2 Write property test for full nation coverage
    - **Property 12: Assignment covers every nation exactly once**
    - **Validates: Requirements 3.1**

  - [x] 4.3 Write property test for minimum one nation per participant
    - **Property 13: Every participant receives at least one nation when nations ≥ participants**
    - **Validates: Requirements 3.2**

  - [x] 4.4 Write property test for balanced distribution
    - **Property 14: Assignment is balanced to within one nation per participant**
    - **Validates: Requirements 3.3**

  - [x] 4.5 Write property test for uniform, order-independent distribution
    - **Property 15: Assignment is uniformly distributed and order-independent**
    - **Validates: Requirements 3.4**
    - Sample many runs from a seeded RNG over fixed small inputs; apply a chi-square / frequency-tolerance check across all enumerated valid distributions plus an order-permutation check

  - [x] 4.6 Write property test for assignment with no participants
    - **Property 16: Assignment with no participants is rejected**
    - **Validates: Requirements 3.5**

  - [x] 4.7 Write property test for assignment with no nations
    - **Property 17: Assignment with no nations is rejected**
    - **Validates: Requirements 3.6**

  - [x] 4.8 Write property test for re-assignment without confirmation
    - **Property 18: Re-assignment without confirmation is rejected**
    - **Validates: Requirements 3.7**

  - [x] 4.9 Write property test for confirmed re-assignment replacement
    - **Property 19: Confirmed re-assignment replaces existing assignments**
    - **Validates: Requirements 3.8**

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement the match recorder
  - [x] 6.1 Implement match recording and updating
    - Implement `recordMatch(state, input)` validating two distinct known nations and integer goal counts 0–99, keyed by the unordered nation pair, returning confirmation by nation pair
    - Implement `updateMatch(state, input)` replacing goals for an existing pair (`MATCH_NOT_FOUND` otherwise), leaving stored matches unchanged on any rejection
    - Implement the match list getter
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8_

  - [x] 6.2 Write property test for valid match recording/retrieval
    - **Property 20: Valid match is recorded and retrievable**
    - **Validates: Requirements 4.1**

  - [x] 6.3 Write property test for unknown-nation rejection
    - **Property 21: Matches referencing unknown nations are rejected**
    - **Validates: Requirements 4.2**

  - [x] 6.4 Write property test for identical-nation rejection
    - **Property 22: Matches with identical nations are rejected**
    - **Validates: Requirements 4.3**

  - [x] 6.5 Write property test for out-of-range goal counts
    - **Property 23: Out-of-range goal counts are rejected**
    - **Validates: Requirements 4.4**

  - [x] 6.6 Write property test for match update replacement
    - **Property 24: Updating an existing match replaces its result**
    - **Validates: Requirements 4.5**

  - [x] 6.7 Write property test for updating a non-stored match
    - **Property 25: Updating a non-stored match is rejected**
    - **Validates: Requirements 4.6, 4.7**

- [x] 7. Implement scoring
  - [x] 7.1 Implement nation and participant points calculation
    - Implement `nationPoints(matches, nationId)`: 3 win/draw points to the higher scorer, 1 each on a draw, plus goal points equal to goal count, summed across all matches
    - Implement `participantPoints(state, participantId)` as the sum over assigned nations, reporting 0 when no assigned nations have results; derived purely from the current match set
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x] 7.2 Write property test for win points
    - **Property 26: Win awards three win/draw points to the higher scorer only**
    - **Validates: Requirements 5.1**

  - [x] 7.3 Write property test for draw points
    - **Property 27: Draw awards one win/draw point to each nation**
    - **Validates: Requirements 5.2**

  - [x] 7.4 Write property test for goal points
    - **Property 28: Goal points equal goal count**
    - **Validates: Requirements 5.3**

  - [x] 7.5 Write property test for nation total points vs reference
    - **Property 29: Nation total points equal the summed win/draw and goal points across its matches**
    - **Validates: Requirements 5.4**

  - [x] 7.6 Write property test for participant total points
    - **Property 30: Participant total points equal the sum of assigned nations' totals**
    - **Validates: Requirements 5.5**

  - [x] 7.7 Write property test for history-independence of points
    - **Property 31: Points depend only on the current match set, not history**
    - **Validates: Requirements 5.6**

- [x] 8. Implement the league table
  - [x] 8.1 Implement league table construction and ranking
    - Implement `buildLeagueTable(state)`: one row per participant with total points; rank = count of participants with strictly greater points + 1; order by points desc then case-insensitive name asc; empty table for empty participant list
    - Implement the league table getter reflecting all stored matches at request time
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

  - [x] 8.2 Write property test for full participant coverage
    - **Property 32: League table covers every participant exactly once**
    - **Validates: Requirements 6.1, 6.6**

  - [x] 8.3 Write property test for rank definition and ordering
    - **Property 33: League ranks are defined by strictly-greater point counts**
    - **Validates: Requirements 6.2, 6.4, 6.5**

  - [x] 8.4 Write property test for tie-break ordering
    - **Property 34: Ties are ordered by case-insensitive ascending name**
    - **Validates: Requirements 6.3**

- [x] 9. Implement prize determination
  - [x] 9.1 Implement champion recording and tournament-winner/league prizes
    - Implement `recordChampion(state, nationId)` rejecting unknown (`UNKNOWN_NATION`) or unassigned (`CHAMPION_NOT_ASSIGNED`) nations and replacing a previously recorded champion
    - Implement `tournamentWinner(state)` (`CHAMPION_NOT_RECORDED` until recorded) and `leaguePrize(state)` returning all rank-1 participants (`LEAGUE_NOT_FINALIZED` until finalized), plus league finalization
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 8.1, 8.2, 8.3, 8.4, 8.5_

  - [x] 9.2 Write property test for assigned-champion holder identification
    - **Property 35: An assigned champion identifies its holder**
    - **Validates: Requirements 7.1**

  - [x] 9.3 Write property test for unknown champion rejection
    - **Property 36: An unknown champion nation is rejected**
    - **Validates: Requirements 7.2**

  - [x] 9.4 Write property test for unassigned champion rejection
    - **Property 37: A champion present but unassigned is rejected**
    - **Validates: Requirements 7.3**

  - [x] 9.5 Write property test for champion replacement
    - **Property 38: Recording a new champion replaces the previous one**
    - **Validates: Requirements 7.4**

  - [x] 9.6 Write property test for tournament winner availability
    - **Property 39: Tournament winner is unavailable until a champion is recorded**
    - **Validates: Requirements 7.6**

  - [x] 9.7 Write property test for league prize recipients
    - **Property 40: League prize recipients are exactly the rank-1 participants**
    - **Validates: Requirements 8.1, 8.2, 8.3**

  - [x] 9.8 Write property test for league prize availability
    - **Property 41: League prize is unavailable until the table is finalized**
    - **Validates: Requirements 8.5**

- [x] 10. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Implement persistence boundary
  - [x] 11.1 Implement the repository over a serialized state document
    - Define the repository interface (load/save `SweepstakeState`) and implement a JSON-document store with atomic write-then-swap
    - _Requirements: 1.8, 2.5, 3.9, 4.8, 5.6, 6.7_

  - [x] 11.2 Write unit tests for serialization round-trips
    - Verify `SweepstakeState` serializes and deserializes losslessly and that a failed write leaves the prior document intact
    - _Requirements: 5.6, 6.7_

- [x] 12. Implement the application service layer
  - [x] 12.1 Wire use cases over the domain core and repository
    - For each use case: load state, call the pure core function, persist only on `ok: true`, and translate the typed result to a response; derive lifecycle flags (assignments exist, champion recorded, league finalized)
    - _Requirements: 1.1, 1.5, 2.1, 2.4, 3.1, 3.8, 4.1, 4.5, 7.1, 7.4, 8.1_

  - [x] 12.2 Write integration tests for service-to-persistence happy paths
    - Verify each use case persists on success and leaves the persisted document unchanged on rejection
    - _Requirements: 1.2, 1.6, 3.7, 4.7, 7.7_

- [x] 13. Implement the HTTP API layer
  - [x] 13.1 Implement participant, nation, and assignment endpoints
    - Implement `POST/DELETE/GET /participants`, `POST/DELETE/GET /nations`, and `POST/GET /assignments`, mapping `DomainError.code` to stable HTTP statuses and JSON error bodies
    - _Requirements: 1.1, 1.5, 1.8, 2.1, 2.4, 2.5, 3.1, 3.8, 3.9_

  - [x] 13.2 Implement match, league-table, and prize endpoints
    - Implement `POST/PUT/GET /matches`, `GET /league-table`, `POST /champion`, `GET /prizes/tournament-winner`, `POST /league/finalize`, and `GET /prizes/league` with status-style bodies for not-yet-available reads
    - _Requirements: 4.1, 4.5, 4.8, 6.7, 7.1, 7.5, 7.6, 8.1, 8.4, 8.5_

  - [x] 13.3 Write integration tests for API error-code mapping
    - Verify each endpoint returns the correct HTTP status and error body for representative success and rejection cases
    - _Requirements: 1.2, 4.2, 4.3, 4.4, 7.2, 7.3_

- [x] 14. End-to-end wiring and flow
  - [x] 14.1 Compose the application entry point
    - Wire API, service, domain core, and repository together with a seeded production RNG and a configured store, and expose a runnable server bootstrap
    - _Requirements: 3.4, 5.6, 6.7_

  - [x] 14.2 Write end-to-end integration test for the full flow
    - Add participants and nations → assign → record matches → view league table → record champion → finalize → read both prizes, using an isolated temporary store cleaned up on completion
    - _Requirements: 3.1, 4.1, 6.7, 7.5, 8.4_

- [x] 15. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP; they are test sub-tasks (property, unit, and integration tests).
- The domain core is pure and the primary target for property-based testing; Properties 1–41 each map to exactly one property-based test using `fast-check` with at least 100 generated cases.
- Each task references specific requirements (granular sub-requirements) for traceability.
- Checkpoints ensure incremental validation as the core, persistence, service, and API layers come together.
- Points and standings are always recomputed from the current match set, so no cache-invalidation tasks are required.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2.1"] },
    { "id": 3, "tasks": ["2.2", "3.1", "4.1", "6.1", "7.1", "9.1"] },
    { "id": 4, "tasks": ["8.1", "11.1", "2.3", "2.4", "2.5", "2.6", "2.7", "2.8", "2.9", "3.2", "3.3", "3.4", "3.5", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7", "4.8", "4.9", "6.2", "6.3", "6.4", "6.5", "6.6", "6.7", "7.2", "7.3", "7.4", "7.5", "7.6", "7.7", "9.2", "9.3", "9.4", "9.5", "9.6"] },
    { "id": 5, "tasks": ["12.1", "11.2", "8.2", "8.3", "8.4", "9.7", "9.8"] },
    { "id": 6, "tasks": ["13.1", "13.2", "12.2"] },
    { "id": 7, "tasks": ["14.1", "13.3"] },
    { "id": 8, "tasks": ["14.2"] }
  ]
}
```
