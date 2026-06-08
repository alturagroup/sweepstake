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
import { JsonFileSweepstakeRepository } from "./persistence/index.js";
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

  return { dataFile, port, host };
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
  const service = new SweepstakeService(repository, rng);
  return createApp(service);
}

/**
 * Compose the application from environment-derived configuration, using the
 * seeded production RNG. Returns the resolved config alongside the
 * not-yet-listening server so a caller (or the direct-run guard below) can log
 * and bind it.
 */
export function createServerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { server: Server; config: ServerConfig } {
  const config = resolveConfig(env);
  const server = buildServer(config.dataFile, createSeededRng());
  return { server, config };
}

/**
 * Build the server from the environment and bind it, logging the data file and
 * the bound address once listening.
 */
export function startFromEnv(env: NodeJS.ProcessEnv = process.env): Server {
  const { server, config } = createServerFromEnv(env);
  server.listen(config.port, config.host, () => {
    const address = server.address();
    const bound =
      address && typeof address === "object"
        ? `${address.address}:${address.port}`
        : String(address);
    console.log(
      `Sweepstake server listening on ${bound} (data file: ${config.dataFile})`,
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
  startFromEnv();
}
