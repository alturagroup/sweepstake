import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  JsonFileSweepstakeRepository,
  emptyState,
} from "./index.js";
import type { SweepstakeState } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Test fixtures and helpers
// ---------------------------------------------------------------------------

/**
 * A fully populated state exercising every field of SweepstakeState so the
 * round-trip assertions cover participants, nations, assignments, matches,
 * championNationId, and leagueFinalized (Requirements 5.6, 6.7).
 */
function populatedState(): SweepstakeState {
  return {
    participants: [
      { id: "p1", displayName: "Alice", normalizedName: "alice" },
      { id: "p2", displayName: "Bob", normalizedName: "bob" },
    ],
    nations: [
      { id: "n1", displayName: "Brazil", normalizedName: "brazil" },
      { id: "n2", displayName: "France", normalizedName: "france" },
      { id: "n3", displayName: "Japan", normalizedName: "japan" },
    ],
    assignments: [
      { nationId: "n1", participantId: "p1" },
      { nationId: "n2", participantId: "p2" },
      { nationId: "n3", participantId: "p1" },
    ],
    matches: [
      { nationAId: "n1", nationBId: "n2", goalsA: 3, goalsB: 1 },
      { nationAId: "n2", nationBId: "n3", goalsA: 0, goalsB: 0 },
    ],
    championNationId: "n1",
    leagueFinalized: true,
  };
}

let tempDir: string;

beforeEach(async () => {
  // Isolated temporary directory per test.
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sweepstake-persist-"));
});

afterEach(async () => {
  // Clean up the temporary directory and everything in it.
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("JsonFileSweepstakeRepository serialization round-trips", () => {
  it("saves then loads a fully populated state losslessly (Requirements 5.6, 6.7)", async () => {
    const filePath = path.join(tempDir, "state.json");
    const repo = new JsonFileSweepstakeRepository(filePath);
    const state = populatedState();

    await repo.save(state);
    const loaded = await repo.load();

    // Deeply equal, covering every field.
    expect(loaded).toEqual(state);
    expect(loaded.participants).toEqual(state.participants);
    expect(loaded.nations).toEqual(state.nations);
    expect(loaded.assignments).toEqual(state.assignments);
    expect(loaded.matches).toEqual(state.matches);
    expect(loaded.championNationId).toBe(state.championNationId);
    expect(loaded.leagueFinalized).toBe(state.leagueFinalized);
  });

  it("round-trips an empty state losslessly", async () => {
    const filePath = path.join(tempDir, "empty.json");
    const repo = new JsonFileSweepstakeRepository(filePath);
    const state = emptyState();

    await repo.save(state);
    const loaded = await repo.load();

    expect(loaded).toEqual(state);
  });

  it("creates missing parent directories when saving", async () => {
    const filePath = path.join(tempDir, "nested", "deeper", "state.json");
    const repo = new JsonFileSweepstakeRepository(filePath);
    const state = populatedState();

    await repo.save(state);
    const loaded = await repo.load();

    expect(loaded).toEqual(state);
  });

  it("returns a fresh empty state when loading a path that was never written", async () => {
    const filePath = path.join(tempDir, "does-not-exist.json");
    const repo = new JsonFileSweepstakeRepository(filePath);

    const loaded = await repo.load();

    expect(loaded).toEqual(emptyState());
    // Loading must not create the file.
    await expect(fs.access(filePath)).rejects.toBeDefined();
  });

  it("leaves the previously saved document intact when a later write fails", async () => {
    const filePath = path.join(tempDir, "state.json");
    const repo = new JsonFileSweepstakeRepository(filePath);
    const original = populatedState();

    // First, a successful save establishes the stored document.
    await repo.save(original);

    // Construct a state that cannot be serialized: a circular reference makes
    // JSON.stringify throw before any write/rename happens, simulating a
    // failed write.
    const broken = populatedState() as SweepstakeState & {
      self?: unknown;
    };
    broken.self = broken;

    await expect(repo.save(broken as SweepstakeState)).rejects.toThrow();

    // The original document must remain intact and loadable.
    const loaded = await repo.load();
    expect(loaded).toEqual(original);

    // No leftover temp files in the directory — only the target document.
    const entries = await fs.readdir(tempDir);
    expect(entries).toEqual(["state.json"]);
  });
});
