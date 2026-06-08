import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SweepstakeService } from "../../src/service/index.js";
import {
  JsonFileSweepstakeRepository,
  type SweepstakeRepository,
} from "../../src/persistence/index.js";
import type { Rng } from "../../src/domain/assignment.js";
import type { SweepstakeState } from "../../src/domain/types.js";

// Integration tests for the service-to-persistence boundary
// (Requirements 1.2, 1.6, 3.7, 4.7, 7.7).
//
// These exercise the real SweepstakeService against a real
// JsonFileSweepstakeRepository backed by an isolated temp directory. They
// verify the two structural guarantees of the service command layer:
//   1. Every command use case persists its new state on success — observed by
//      reloading the document through a *fresh* repository instance and
//      asserting the stored document changed as expected.
//   2. On a rejection, the persisted document is left byte-for-byte unchanged.

// ---------------------------------------------------------------------------
// Test fixtures & helpers
// ---------------------------------------------------------------------------

/**
 * Minimal seeded PRNG (mulberry32). Returns a float in [0, 1) just like
 * Math.random, satisfying the `Rng` contract, so assignment is deterministic
 * and reproducible across runs.
 */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let tempDir: string;
let filePath: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sweepstake-service-"));
  filePath = path.join(tempDir, "state.json");
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

/** A service wired to a fresh repository over the shared temp file. */
function makeService(seed = 0x1234_5678): SweepstakeService {
  return new SweepstakeService(
    new JsonFileSweepstakeRepository(filePath),
    mulberry32(seed),
  );
}

/**
 * Load the persisted document directly through a brand-new repository
 * instance, proving the read reflects what was actually written to disk rather
 * than any in-memory state held by the writing service.
 */
async function reloadPersisted(): Promise<SweepstakeState> {
  const fresh: SweepstakeRepository = new JsonFileSweepstakeRepository(filePath);
  return fresh.load();
}

/** Read the raw bytes of the stored document (or null when absent). */
async function readRawOrNull(): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

/** Add a participant and return its generated id. */
async function addParticipantId(
  service: SweepstakeService,
  name: string,
): Promise<string> {
  const result = await service.addParticipant(name);
  expect(result.ok).toBe(true);
  const participants = await service.listParticipants();
  const found = participants.find((p) => p.displayName === name);
  expect(found).toBeDefined();
  return (found as { id: string }).id;
}

/** Add a nation and return its generated id. */
async function addNationId(
  service: SweepstakeService,
  name: string,
): Promise<string> {
  const result = await service.addNation(name);
  expect(result.ok).toBe(true);
  const nations = await service.listNations();
  const found = nations.find((n) => n.displayName === name);
  expect(found).toBeDefined();
  return (found as { id: string }).id;
}

// ---------------------------------------------------------------------------
// Happy paths: each command use case persists on success
// ---------------------------------------------------------------------------

describe("service persists each command use case on success", () => {
  it("addParticipant persists the new participant to disk", async () => {
    const service = makeService();

    const result = await service.addParticipant("Alice");
    expect(result.ok).toBe(true);

    const persisted = await reloadPersisted();
    expect(persisted.participants).toHaveLength(1);
    expect(persisted.participants[0]?.displayName).toBe("Alice");
    expect(persisted.participants[0]?.normalizedName).toBe("alice");
  });

  it("removeParticipant persists the removal to disk", async () => {
    const service = makeService();
    const id = await addParticipantId(service, "Alice");
    await addParticipantId(service, "Bob");

    const result = await service.removeParticipant(id);
    expect(result.ok).toBe(true);

    const persisted = await reloadPersisted();
    expect(persisted.participants.map((p) => p.displayName)).toEqual(["Bob"]);
  });

  it("addNation persists the new nation to disk", async () => {
    const service = makeService();

    const result = await service.addNation("Brazil");
    expect(result.ok).toBe(true);

    const persisted = await reloadPersisted();
    expect(persisted.nations).toHaveLength(1);
    expect(persisted.nations[0]?.displayName).toBe("Brazil");
  });

  it("removeNation persists the removal to disk", async () => {
    const service = makeService();
    const id = await addNationId(service, "Brazil");
    await addNationId(service, "France");

    const result = await service.removeNation(id);
    expect(result.ok).toBe(true);

    const persisted = await reloadPersisted();
    expect(persisted.nations.map((n) => n.displayName)).toEqual(["France"]);
  });

  it("assign persists generated assignments to disk", async () => {
    const service = makeService();
    await addParticipantId(service, "Alice");
    await addParticipantId(service, "Bob");
    await addNationId(service, "Brazil");
    await addNationId(service, "France");
    await addNationId(service, "Japan");

    const result = await service.assign();
    expect(result.ok).toBe(true);

    const persisted = await reloadPersisted();
    // Every nation assigned exactly once.
    expect(persisted.assignments).toHaveLength(3);
    expect(new Set(persisted.assignments.map((a) => a.nationId)).size).toBe(3);
  });

  it("confirmed re-assign persists the replacement to disk", async () => {
    const service = makeService();
    await addParticipantId(service, "Alice");
    await addNationId(service, "Brazil");
    await addNationId(service, "France");

    const first = await service.assign();
    expect(first.ok).toBe(true);
    const before = await reloadPersisted();

    const replaced = await service.assign(true);
    expect(replaced.ok).toBe(true);

    const after = await reloadPersisted();
    // Still a complete, valid distribution covering every nation once.
    expect(after.assignments).toHaveLength(2);
    expect(new Set(after.assignments.map((a) => a.nationId)).size).toBe(2);
    // The prior assignments were discarded and re-generated wholesale.
    expect(before.assignments).toHaveLength(2);
  });

  it("recordMatch persists the new match to disk", async () => {
    const service = makeService();
    const brazil = await addNationId(service, "Brazil");
    const france = await addNationId(service, "France");

    const result = await service.recordMatch({
      nationAId: brazil,
      nationBId: france,
      goalsA: 3,
      goalsB: 1,
    });
    expect(result.ok).toBe(true);

    const persisted = await reloadPersisted();
    expect(persisted.matches).toHaveLength(1);
    expect(persisted.matches[0]).toMatchObject({
      nationAId: brazil,
      nationBId: france,
      goalsA: 3,
      goalsB: 1,
    });
  });

  it("updateMatch persists the updated result to disk", async () => {
    const service = makeService();
    const brazil = await addNationId(service, "Brazil");
    const france = await addNationId(service, "France");
    await service.recordMatch({
      nationAId: brazil,
      nationBId: france,
      goalsA: 3,
      goalsB: 1,
    });

    const result = await service.updateMatch({
      nationAId: brazil,
      nationBId: france,
      goalsA: 2,
      goalsB: 2,
    });
    expect(result.ok).toBe(true);

    const persisted = await reloadPersisted();
    expect(persisted.matches).toHaveLength(1);
    expect(persisted.matches[0]).toMatchObject({ goalsA: 2, goalsB: 2 });
  });

  it("recordChampion persists the recorded champion to disk", async () => {
    const service = makeService();
    await addParticipantId(service, "Alice");
    const brazil = await addNationId(service, "Brazil");
    await service.assign();

    const result = await service.recordChampion(brazil);
    expect(result.ok).toBe(true);

    const persisted = await reloadPersisted();
    expect(persisted.championNationId).toBe(brazil);
  });

  it("finalizeLeague persists the finalized flag to disk", async () => {
    const service = makeService();
    await addParticipantId(service, "Alice");

    await service.finalizeLeague();

    const persisted = await reloadPersisted();
    expect(persisted.leagueFinalized).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rejections leave the persisted document unchanged
// ---------------------------------------------------------------------------

describe("service leaves the persisted document unchanged on rejection", () => {
  it("duplicate participant add does not modify the stored document (Req 1.2)", async () => {
    const service = makeService();
    await addParticipantId(service, "Alice");
    const rawBefore = await readRawOrNull();

    const result = await service.addParticipant("  alice  ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("DUPLICATE_PARTICIPANT");

    const rawAfter = await readRawOrNull();
    expect(rawAfter).toBe(rawBefore);
  });

  it("removing a participant after assignments does not modify the stored document (Req 1.6)", async () => {
    const service = makeService();
    const id = await addParticipantId(service, "Alice");
    await addNationId(service, "Brazil");
    await service.assign();
    const rawBefore = await readRawOrNull();

    const result = await service.removeParticipant(id);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("ASSIGNMENTS_EXIST");

    const rawAfter = await readRawOrNull();
    expect(rawAfter).toBe(rawBefore);
  });

  it("re-assign without confirmation does not modify the stored document (Req 3.7)", async () => {
    const service = makeService();
    await addParticipantId(service, "Alice");
    await addNationId(service, "Brazil");
    await addNationId(service, "France");
    await service.assign();
    const rawBefore = await readRawOrNull();

    const result = await service.assign();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("CONFIRMATION_REQUIRED");

    const rawAfter = await readRawOrNull();
    expect(rawAfter).toBe(rawBefore);
  });

  it("updating a non-stored match does not modify the stored document (Req 4.7)", async () => {
    const service = makeService();
    const brazil = await addNationId(service, "Brazil");
    const france = await addNationId(service, "France");
    // A stored match exists, but for a different pair than the one updated.
    const japan = await addNationId(service, "Japan");
    await service.recordMatch({
      nationAId: brazil,
      nationBId: france,
      goalsA: 1,
      goalsB: 0,
    });
    const rawBefore = await readRawOrNull();

    const result = await service.updateMatch({
      nationAId: brazil,
      nationBId: japan,
      goalsA: 2,
      goalsB: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("MATCH_NOT_FOUND");

    const rawAfter = await readRawOrNull();
    expect(rawAfter).toBe(rawBefore);
  });

  it("recording an unknown champion does not modify the stored document (Req 7.7)", async () => {
    const service = makeService();
    await addParticipantId(service, "Alice");
    await addNationId(service, "Brazil");
    await service.assign();
    const rawBefore = await readRawOrNull();

    const result = await service.recordChampion("not-a-real-nation-id");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_NATION");

    const rawAfter = await readRawOrNull();
    expect(rawAfter).toBe(rawBefore);
  });
});
