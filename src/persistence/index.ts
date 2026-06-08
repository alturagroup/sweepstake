// Persistence Boundary.
//
// Defines the repository interface that hides the storage mechanism from the
// service layer, plus a JSON-document store implementation. The whole
// sweepstake is persisted as a single serialized JSON state document so that
// reads (participant/nation/assignment/match lists, league table) always
// reflect the most recently saved write (Requirements 1.8, 2.5, 3.9, 4.8,
// 5.6, 6.7).
//
// Writes are atomic: the new document is written to a temporary file and then
// renamed over the target path. `fs.promises.rename` is atomic on the same
// filesystem, so a process crash or failed write can never leave a partially
// updated state document behind — readers see either the old document or the
// fully written new one.

import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { SweepstakeState } from "../domain/types.js";

/**
 * Persistence boundary for the sweepstake. Implementations hide the concrete
 * storage choice (JSON file, embedded store, etc.) behind load/save of the
 * complete {@link SweepstakeState} document.
 */
export interface SweepstakeRepository {
  /**
   * Load the current state. When no state has ever been persisted, a fresh
   * empty state is returned so callers can treat first-run identically to a
   * normal load.
   */
  load(): Promise<SweepstakeState>;

  /**
   * Persist the complete state document, replacing any previously stored
   * state. The write is atomic: on success the entire document is stored; on
   * failure the previously stored document is left intact.
   */
  save(state: SweepstakeState): Promise<void>;
}

/**
 * A fresh, empty sweepstake state. Used as the default when no document exists
 * yet so first-run behaves like loading an empty store.
 */
export function emptyState(): SweepstakeState {
  return {
    participants: [],
    nations: [],
    assignments: [],
    matches: [],
    championNationId: null,
    leagueFinalized: false,
  };
}

/**
 * JSON-file-backed implementation of {@link SweepstakeRepository}. The entire
 * state is stored as a single pretty-printed JSON document at `filePath`.
 *
 * Saving uses a write-then-swap strategy: the serialized document is written
 * to a unique temporary file in the same directory, then atomically renamed
 * over the target path. Keeping the temp file on the same filesystem ensures
 * `rename` is atomic, so a failed or interrupted write cannot corrupt or
 * partially overwrite the existing document.
 */
export class JsonFileSweepstakeRepository implements SweepstakeRepository {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async load(): Promise<SweepstakeState> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error: unknown) {
      if (isNotFound(error)) {
        // No document persisted yet — treat as an empty store.
        return emptyState();
      }
      throw error;
    }
    return JSON.parse(raw) as SweepstakeState;
  }

  async save(state: SweepstakeState): Promise<void> {
    const dir = path.dirname(this.filePath);
    // Ensure the target directory exists before writing.
    await fs.mkdir(dir, { recursive: true });

    const serialized = JSON.stringify(state, null, 2);
    const tempPath = path.join(
      dir,
      `.${path.basename(this.filePath)}.${randomBytes(8).toString("hex")}.tmp`,
    );

    try {
      // Write the full document to a temp file first...
      await fs.writeFile(tempPath, serialized, "utf8");
      // ...then atomically swap it into place. On the same filesystem this is
      // atomic, so readers never observe a partial document.
      await fs.rename(tempPath, this.filePath);
    } catch (error: unknown) {
      // Best-effort cleanup of the temp file; the original document (if any)
      // remains untouched because the rename never completed.
      await fs.rm(tempPath, { force: true }).catch(() => {
        /* ignore cleanup failures */
      });
      throw error;
    }
  }
}

/** True when an error represents a missing file (`ENOENT`). */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
