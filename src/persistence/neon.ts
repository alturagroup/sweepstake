// Neon (Postgres) persistence implementation.
//
// A second {@link SweepstakeRepository} backed by a Neon serverless Postgres
// database. The whole sweepstake is a single `SweepstakeState` document, so it
// is stored as one JSONB row in a `sweepstake_state` table keyed by a fixed id.
// This mirrors the JSON-file store's "load/save the entire document" contract,
// so the service layer is unchanged regardless of which repository is wired in.
//
// The `save` is performed as an upsert (INSERT ... ON CONFLICT DO UPDATE),
// which is atomic at the row level: a concurrent reader sees either the prior
// document or the fully written new one, never a partial write — preserving the
// same guarantee the file store provides via write-then-swap.

import { neon } from "@neondatabase/serverless";

import type { SweepstakeState } from "../domain/types.js";
import { type SweepstakeRepository, emptyState } from "./index.js";

/** Fixed primary-key value for the single state row. */
const STATE_ID = 1;

/**
 * Create a Neon SQL client from a connection string.
 *
 * Kept as a separate factory so the connection string is validated in exactly
 * one place. The string is a secret (it embeds credentials); callers should
 * source it from the environment (e.g. `process.env.DATABASE_URL`) and never
 * hard-code or log it.
 */
function createClient(connectionString: string): ReturnType<typeof neon> {
  if (!connectionString || connectionString.trim().length === 0) {
    throw new Error(
      "A non-empty Neon connection string (DATABASE_URL) is required.",
    );
  }
  return neon(connectionString);
}

/**
 * Neon-backed implementation of {@link SweepstakeRepository}.
 *
 * Persists the complete {@link SweepstakeState} as a single JSONB row. Use
 * {@link NeonSweepstakeRepository.create} to construct an instance with its
 * table ensured, or the constructor directly when the schema is managed
 * elsewhere (e.g. a migration).
 */
export class NeonSweepstakeRepository implements SweepstakeRepository {
  private readonly sql: ReturnType<typeof neon>;

  constructor(connectionString: string) {
    this.sql = createClient(connectionString);
  }

  /**
   * Construct a repository and ensure the backing table exists. Convenient for
   * simple deployments without a separate migration step.
   */
  static async create(
    connectionString: string,
  ): Promise<NeonSweepstakeRepository> {
    const repo = new NeonSweepstakeRepository(connectionString);
    await repo.ensureSchema();
    return repo;
  }

  /**
   * Create the `sweepstake_state` table if it does not already exist. Safe to
   * call repeatedly (idempotent).
   */
  async ensureSchema(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS sweepstake_state (
        id INTEGER PRIMARY KEY,
        state JSONB NOT NULL
      )
    `;
  }

  /**
   * Load the current state. Returns a fresh empty state when no row has been
   * persisted yet, so first-run behaves like a normal load.
   */
  async load(): Promise<SweepstakeState> {
    const rows = (await this.sql`
      SELECT state FROM sweepstake_state WHERE id = ${STATE_ID}
    `) as Array<{ state: SweepstakeState }>;

    const row = rows[0];
    if (row === undefined) {
      return emptyState();
    }
    return row.state;
  }

  /**
   * Persist the complete state document via an atomic row-level upsert. On
   * failure the previously stored row is left intact.
   */
  async save(state: SweepstakeState): Promise<void> {
    await this.sql`
      INSERT INTO sweepstake_state (id, state)
      VALUES (${STATE_ID}, ${JSON.stringify(state)})
      ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state
    `;
  }
}
