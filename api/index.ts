// Vercel serverless entry point.
//
// Vercel runs serverless functions, not a long-lived HTTP server, so the
// persistent `createApp().listen()` bootstrap in src/main.ts cannot be used
// here. Instead this function reuses the shared request listener
// (`createRequestListener`) — the same routing/validation/error-mapping the
// standalone server uses — and is invoked once per request.
//
// Persistence MUST be Neon: Vercel's filesystem is read-only/ephemeral, so the
// JSON-file store would fail. `DATABASE_URL` is therefore required and is
// validated at module load. The service is built once per cold start and
// reused across invocations on the same warm instance.

import type { IncomingMessage, ServerResponse } from "node:http";

import { createRequestListener } from "../src/api/index.js";
import { createSeededRng } from "../src/main.js";
import { NeonSweepstakeRepository } from "../src/persistence/neon.js";
import { SweepstakeService } from "../src/service/index.js";

/**
 * Lazily build (and memoize) the request listener for the lifetime of the warm
 * serverless instance. The Neon schema is ensured on first use; subsequent
 * invocations reuse the same promise so the table check runs at most once per
 * instance.
 */
let listenerPromise:
  | Promise<(req: IncomingMessage, res: ServerResponse) => void>
  | null = null;

function getListener(): Promise<
  (req: IncomingMessage, res: ServerResponse) => void
> {
  if (listenerPromise === null) {
    listenerPromise = (async () => {
      const databaseUrl = process.env.DATABASE_URL;
      if (!databaseUrl || databaseUrl.trim().length === 0) {
        throw new Error(
          "DATABASE_URL is required for the Vercel deployment (the JSON-file store cannot run on Vercel's ephemeral filesystem).",
        );
      }
      const repository = await NeonSweepstakeRepository.create(databaseUrl);
      const service = new SweepstakeService(repository, createSeededRng());
      return createRequestListener(service);
    })();
    // If construction fails, clear the cache so a later invocation can retry
    // rather than permanently serving the rejected promise.
    listenerPromise.catch(() => {
      listenerPromise = null;
    });
  }
  return listenerPromise;
}

/**
 * Vercel Node serverless handler. `req`/`res` are Node
 * `IncomingMessage`/`ServerResponse`, which the shared listener already speaks.
 */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let listener: (req: IncomingMessage, res: ServerResponse) => void;
  try {
    listener = await getListener();
  } catch (error: unknown) {
    // Never echo the raw error message: it can contain the connection string
    // (including credentials). Log server-side, return a generic message.
    console.error("Service initialization failed:", error);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        code: "INITIALIZATION_ERROR",
        message:
          "The service failed to initialize. Check that DATABASE_URL is configured correctly.",
      }),
    );
    return;
  }
  listener(req, res);
}
