// Application entry point (composition root).
//
// Wires the layers together into a runnable server: a JSON-file repository
// (the persistence boundary), a cryptographically seeded production RNG fed to
// the assignment engine via the service, and the HTTP API built over that
// service. Configuration is read from the environment so the same bootstrap
// works across local runs and deployments:
//
//   - SWEEPSTAKE_DATA_FILE : path to the JSON state document
//                            (default: <cwd>/data/sweepstake.json)
//   - PORT                 : TCP port to bind (default: 3000)
//   - HOST                 : interface to bind (default: 0.0.0.0)
//
// The composition is exposed as factory functions (`buildServer`,
// `createServerFromEnv`) so tests can construct an equivalent server over an
// isolated store without binding a port or starting a listener. The actual
// `listen()` call is guarded so that importing this module (e.g. from a test)
// never starts the server — it only starts when the module is executed
// directly as the program entry point.

import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./api/index.js";
import type { Rng } from "./domain/assignment.js";
import {
  JsonFileSweepstakeRepository,
  type SweepstakeRepository,
} from "./persistence/index.js";
import { NeonSweepstakeRepository } from "./persistence/neon.js";
import { SweepstakeService } from "./service/index.js";

/** Default path for the JSON state document when SWEEPSTAKE_DATA_FILE is unset. */
const DEFAULT_DATA_FILE = path.join(process.cwd(), "data", "sweepstake.json");

/** Default TCP port when PORT is unset or invalid. */
const DEFAULT_PORT = 3000;

/** Default bind interface when HOST is unset. */
const DEFAULT_HOST = "0.0.0.0";

/**
 * Create a seeded production RNG satisfying the {@link Rng} contract
 * (`() => number` in `[0, 1)`).
 *
 * The generator is a mulberry32 PRNG seeded from a 32-bit value drawn from
 * `node:crypto` `randomBytes`, so each process gets an unpredictable,
 * high-quality stream while still flowing through the same injectable seam the
 * tests use. Keeping randomness injected (rather than calling `Math.random`
 * inside the engine) preserves the reproducibility and testability of the
 * uniform-distribution requirement.
 */
export function createSeededRng(seed: number = randomBytes(4).readUInt32LE(0)): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Resolved server configuration. */
export interface ServerConfig {
  /** Path to the JSON state document. */
  dataFile: string;
  /** TCP port to bind. */
  port: number;
  /** Network interface to bind. */
  host: string;
  /**
   * Neon Postgres connection string. When present, the app persists to Neon
   * instead of the JSON file. Sourced from `DATABASE_URL`; it is a secret and
   * is never logged.
   */
  databaseUrl: string | null;
}

/**
 * Resolve the {@link ServerConfig} from the given environment, applying
 * sensible defaults for any unset or invalid values.
 */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const dataFile =
    env.SWEEPSTAKE_DATA_FILE && env.SWEEPSTAKE_DATA_FILE.trim().length > 0
      ? env.SWEEPSTAKE_DATA_FILE
      : DEFAULT_DATA_FILE;

  const parsedPort = Number.parseInt(env.PORT ?? "", 10);
  const port =
    Number.isInteger(parsedPort) && parsedPort >= 0 && parsedPort <= 65535
      ? parsedPort
      : DEFAULT_PORT;

  const host =
    env.HOST && env.HOST.trim().length > 0 ? env.HOST : DEFAULT_HOST;

  const databaseUrl =
    env.DATABASE_URL && env.DATABASE_URL.trim().length > 0
      ? env.DATABASE_URL
      : null;

  return { dataFile, port, host, databaseUrl };
}

/**
 * Compose the full application over an explicit data-file path and RNG, and
 * return the (not-yet-listening) HTTP server.
 *
 * This is the testable composition root: callers can point it at an isolated
 * temporary store and inject a deterministic RNG, then drive the returned
 * server directly or bind it to an ephemeral port.
 */
export function buildServer(
  dataFile: string,
  rng: Rng = createSeededRng(),
): Server {
  const repository = new JsonFileSweepstakeRepository(dataFile);
  return buildServerFromRepository(repository, rng);
}

/**
 * Compose the full application over an explicit repository and RNG. This is the
 * storage-agnostic seam: any {@link SweepstakeRepository} (JSON file, Neon,
 * etc.) can be wired in without the API or service layers changing.
 */
export function buildServerFromRepository(
  repository: SweepstakeRepository,
  rng: Rng = createSeededRng(),
): Server {
  const service = new SweepstakeService(repository, rng);
  return createApp(service);
}

/**
 * Select the persistence repository from configuration: a Neon-backed store
 * when `DATABASE_URL` is set (its schema is ensured up front), otherwise the
 * JSON-file store. Returns the repository plus a label for startup logging.
 */
export async function createRepositoryFromConfig(
  config: ServerConfig,
): Promise<{ repository: SweepstakeRepository; description: string }> {
  if (config.databaseUrl !== null) {
    const repository = await NeonSweepstakeRepository.create(
      config.databaseUrl,
    );
    return { repository, description: "Neon Postgres" };
  }
  return {
    repository: new JsonFileSweepstakeRepository(config.dataFile),
    description: `JSON file: ${config.dataFile}`,
  };
}

/**
 * Compose the application from environment-derived configuration, using the
 * seeded production RNG and the configured persistence backend (Neon when
 * `DATABASE_URL` is set, otherwise the JSON file). Returns the resolved config
 * and a storage description alongside the not-yet-listening server so a caller
 * (or the direct-run guard below) can log and bind it.
 *
 * Async because selecting the Neon backend ensures its schema up front.
 */
export async function createServerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ server: Server; config: ServerConfig; storage: string }> {
  const config = resolveConfig(env);
  const { repository, description } = await createRepositoryFromConfig(config);
  const server = buildServerFromRepository(repository, createSeededRng());
  return { server, config, storage: description };
}

/**
 * Build the server from the environment and bind it, logging the storage
 * backend and the bound address once listening.
 */
export async function startFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Server> {
  const { server, config, storage } = await createServerFromEnv(env);
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const bound =
      address && typeof address === "object"
        ? `${address.address}:${address.port}`
        : String(address);
    console.log(
      `Sweepstake server listening on ${bound} (storage: ${storage})`,
    );
  });
  return server;
}

/**
 * True when this module is being executed directly as the program entry point
 * (as opposed to being imported by a test or another module). Comparing the
 * resolved module URL against the invoked script path keeps the `listen()`
 * call from firing during imports.
 */
function isMainModule(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) {
    return false;
  }
  try {
    return fileURLToPath(import.meta.url) === path.resolve(invoked);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  startFromEnv().catch((error: unknown) => {
    console.error("Failed to start the sweepstake server:", error);
    process.exitCode = 1;
  });
}
