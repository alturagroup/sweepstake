// Interface Layer (HTTP API).
//
// Maps HTTP requests onto the application service use cases and translates the
// domain's typed results into HTTP responses. The whole layer is built on
// Node's built-in `http` module (no web framework dependency) and is exposed
// as a factory, `createApp(service)`, so tests can construct a server over an
// in-memory/temporary service without binding a port.
//
// Error handling contract (see design "Error Handling"):
// - Validation / distinctness / range  -> 400 Bad Request
//     (NAME_REQUIRED, NAME_TOO_LONG, NATIONS_NOT_DISTINCT, GOALS_OUT_OF_RANGE)
// - Duplicates                         -> 409 Conflict
//     (DUPLICATE_PARTICIPANT, DUPLICATE_NATION)
// - Not-found                          -> 404 Not Found
//     (PARTICIPANT_NOT_FOUND, MATCH_NOT_FOUND, UNKNOWN_NATION)
// - Lifecycle conflicts                -> 409 Conflict
//     (ASSIGNMENTS_EXIST, CONFIRMATION_REQUIRED, NO_PARTICIPANTS, NO_NATIONS,
//      CHAMPION_NOT_ASSIGNED)
// - Status-style reads before prereqs  -> 200 OK with an explicit status body
//     (CHAMPION_NOT_RECORDED, LEAGUE_NOT_FINALIZED)
//
// Every error response body has the stable shape `{ code, message, ...context }`.

import { type IncomingMessage, type Server, ServerResponse, createServer } from "node:http";

import type { MatchInput } from "../domain/matches.js";
import type { DomainError, Result, SweepstakeState } from "../domain/types.js";
import type { SweepstakeService } from "../service/index.js";

/**
 * Codes that represent a not-yet-available read rather than a failure. The
 * corresponding read endpoints respond `200 OK` with an explicit status body
 * so callers can distinguish "not ready yet" from a genuine error.
 */
type StatusCode = "CHAMPION_NOT_RECORDED" | "LEAGUE_NOT_FINALIZED";

/** Human-readable messages keyed by `DomainError.code`. */
const ERROR_MESSAGES: Record<DomainError["code"], string> = {
  NAME_REQUIRED: "A non-empty name is required.",
  NAME_TOO_LONG: "Name must be at most 100 characters after trimming.",
  DUPLICATE_PARTICIPANT: "A participant with this name already exists.",
  DUPLICATE_NATION: "A nation with this name already exists.",
  ASSIGNMENTS_EXIST: "Operation not allowed while assignments exist.",
  PARTICIPANT_NOT_FOUND: "No participant exists with the given id.",
  NO_PARTICIPANTS: "At least one participant is required.",
  NO_NATIONS: "At least one nation is required.",
  CONFIRMATION_REQUIRED:
    "Assignments already exist; confirm replacement to continue.",
  UNKNOWN_NATION: "The referenced nation is not recognized.",
  NATIONS_NOT_DISTINCT: "A match must be between two distinct nations.",
  GOALS_OUT_OF_RANGE: "Goal counts must be integers between 0 and 99.",
  MATCH_NOT_FOUND: "No match exists for the given nation pair.",
  CHAMPION_NOT_ASSIGNED: "The champion nation has not been assigned.",
  CHAMPION_NOT_RECORDED: "No champion has been recorded yet.",
  LEAGUE_NOT_FINALIZED: "The league table has not been finalized yet.",
};

/**
 * Map a `DomainError.code` to its stable HTTP status. This is the single
 * source of truth for status mapping across the whole API surface.
 *
 * Note: `CHAMPION_NOT_RECORDED` and `LEAGUE_NOT_FINALIZED` are status-style
 * reads handled separately (200 with a status body); if they ever reach this
 * function they are reported as `409 Conflict`.
 */
export function httpStatusForError(code: DomainError["code"]): number {
  switch (code) {
    case "NAME_REQUIRED":
    case "NAME_TOO_LONG":
    case "NATIONS_NOT_DISTINCT":
    case "GOALS_OUT_OF_RANGE":
      return 400;
    case "DUPLICATE_PARTICIPANT":
    case "DUPLICATE_NATION":
      return 409;
    case "PARTICIPANT_NOT_FOUND":
    case "MATCH_NOT_FOUND":
    case "UNKNOWN_NATION":
      return 404;
    case "ASSIGNMENTS_EXIST":
    case "CONFIRMATION_REQUIRED":
    case "NO_PARTICIPANTS":
    case "NO_NATIONS":
    case "CHAMPION_NOT_ASSIGNED":
    case "CHAMPION_NOT_RECORDED":
    case "LEAGUE_NOT_FINALIZED":
      return 409;
    default: {
      // Exhaustiveness guard: a new code must be classified explicitly. The
      // `never` assignment makes adding an unhandled code a compile error.
      return assertNever(code);
    }
  }
}

/**
 * Compile-time exhaustiveness guard. Reaching this at runtime means a new
 * `DomainError.code` was added without a status classification.
 */
function assertNever(value: never): never {
  throw new Error(`Unhandled domain error code: ${String(value)}`);
}

/** Whether a code is a status-style read (200 with status body) rather than an error. */
function isStatusCode(code: DomainError["code"]): code is StatusCode {
  return code === "CHAMPION_NOT_RECORDED" || code === "LEAGUE_NOT_FINALIZED";
}

/**
 * Build the JSON error body for a domain error: the stable `code`, a
 * human-readable `message`, and any contextual fields the error carries (e.g.
 * `nation` for `UNKNOWN_NATION`).
 */
function errorBody(error: DomainError): Record<string, unknown> {
  const { code, ...context } = error;
  return { code, message: ERROR_MESSAGES[code], ...context };
}

/** Write a JSON response with the given status code. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(payload);
}

/** Write a domain error as an HTTP error response using the central status map. */
function sendError(res: ServerResponse, error: DomainError): void {
  sendJson(res, httpStatusForError(error.code), errorBody(error));
}

/**
 * Translate a command `Result` into an HTTP response: `200 OK` with the success
 * payload, or the mapped error status and body on rejection.
 */
function sendCommandResult<T>(
  res: ServerResponse,
  result: Result<T, DomainError>,
  success: (value: T) => unknown,
): void {
  if (result.ok) {
    sendJson(res, 200, success(result.value));
  } else {
    sendError(res, result.error);
  }
}

/**
 * Translate a status-style read `Result` into an HTTP response. On success the
 * value is returned with `200 OK`. When the error is a status-style code
 * (`CHAMPION_NOT_RECORDED`, `LEAGUE_NOT_FINALIZED`), respond `200 OK` with an
 * explicit `{ status, message }` body. Any other error maps normally.
 */
function sendStatusResult<T>(
  res: ServerResponse,
  result: Result<T, DomainError>,
  success: (value: T) => unknown,
): void {
  if (result.ok) {
    sendJson(res, 200, success(result.value));
    return;
  }
  if (isStatusCode(result.error.code)) {
    sendJson(res, 200, {
      status: result.error.code,
      message: ERROR_MESSAGES[result.error.code],
    });
    return;
  }
  sendError(res, result.error);
}

/** Read and JSON-parse a request body. Returns `{}` for an empty body. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }
  return JSON.parse(raw);
}

/** Narrow an unknown parsed body to a plain object (never null/array). */
function asObject(body: unknown): Record<string, unknown> {
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

/** Build a `MatchInput` from a request body, coercing fields as-is for the domain to validate. */
function toMatchInput(body: Record<string, unknown>): MatchInput {
  return {
    nationAId: String(body.nationAId ?? ""),
    nationBId: String(body.nationBId ?? ""),
    goalsA: body.goalsA as number,
    goalsB: body.goalsB as number,
  };
}

/**
 * Strip derived fields and return a minimal acknowledgement for a successful
 * state-changing command. The full state is intentionally not serialized back;
 * callers re-read via the GET endpoints.
 */
function ok(): { ok: true } {
  return { ok: true };
}

/**
 * Build the request listener that powers the API: routing, body parsing, and
 * error mapping over the given service. Shared by both the persistent
 * {@link createApp} server and serverless function adapters (e.g. Vercel),
 * since both receive Node `IncomingMessage`/`ServerResponse` objects.
 */
export function createRequestListener(
  service: SweepstakeService,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handleRequest(service, req, res).catch((error: unknown) => {
      // Distinguish malformed JSON bodies (client error) from unexpected
      // internal failures, without leaking internal detail.
      if (error instanceof SyntaxError) {
        sendJson(res, 400, {
          code: "INVALID_JSON",
          message: "Request body is not valid JSON.",
        });
        return;
      }
      sendJson(res, 500, {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
      });
    });
  };
}

/**
 * Create the HTTP server for the sweepstake API, wired over the given service.
 *
 * The returned server is not yet listening; the caller decides when/where to
 * bind (production bootstrap binds a port; tests can drive it directly or via
 * an ephemeral port). All routing, body parsing, and error mapping is handled
 * internally.
 */
export function createApp(service: SweepstakeService): Server {
  return createServer(createRequestListener(service));
}

/** Match a pathname like `/participants/{id}` and return the decoded id, or null. */
function matchIdRoute(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(`${prefix}/`)) {
    return null;
  }
  const id = pathname.slice(prefix.length + 1);
  if (id.length === 0 || id.includes("/")) {
    return null;
  }
  return decodeURIComponent(id);
}

/**
 * Route a single request to the appropriate service use case and write the
 * response. Throws only for malformed JSON or unexpected internal errors, which
 * are handled by the wrapper in {@link createApp}.
 */
async function handleRequest(
  service: SweepstakeService,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";

  // --- Participants -------------------------------------------------------
  if (pathname === "/participants") {
    if (method === "POST") {
      const body = asObject(await readJsonBody(req));
      const result = await service.addParticipant(String(body.name ?? ""));
      sendCommandResult(res, result, ok);
      return;
    }
    if (method === "GET") {
      sendJson(res, 200, await service.listParticipants());
      return;
    }
    methodNotAllowed(res);
    return;
  }
  const participantId = matchIdRoute(pathname, "/participants");
  if (participantId !== null) {
    if (method === "DELETE") {
      const result = await service.removeParticipant(participantId);
      sendCommandResult(res, result, ok);
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // --- Nations ------------------------------------------------------------
  if (pathname === "/nations") {
    if (method === "POST") {
      const body = asObject(await readJsonBody(req));
      const result = await service.addNation(String(body.name ?? ""));
      sendCommandResult(res, result, ok);
      return;
    }
    if (method === "GET") {
      sendJson(res, 200, await service.listNations());
      return;
    }
    methodNotAllowed(res);
    return;
  }
  const nationId = matchIdRoute(pathname, "/nations");
  if (nationId !== null) {
    if (method === "DELETE") {
      const result = await service.removeNation(nationId);
      sendCommandResult(res, result, ok);
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // --- Assignments --------------------------------------------------------
  if (pathname === "/assignments") {
    if (method === "POST") {
      const body = asObject(await readJsonBody(req));
      const confirmReplace = body.confirmReplace === true;
      const result = await service.assign(confirmReplace);
      sendCommandResult(res, result, ok);
      return;
    }
    if (method === "GET") {
      sendJson(res, 200, await service.listAssignments());
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // --- Matches ------------------------------------------------------------
  if (pathname === "/matches") {
    if (method === "POST") {
      const body = asObject(await readJsonBody(req));
      const result = await service.recordMatch(toMatchInput(body));
      sendCommandResult(res, result, ok);
      return;
    }
    if (method === "PUT") {
      const body = asObject(await readJsonBody(req));
      const result = await service.updateMatch(toMatchInput(body));
      sendCommandResult(res, result, ok);
      return;
    }
    if (method === "GET") {
      sendJson(res, 200, await service.listMatches());
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // --- League table -------------------------------------------------------
  if (pathname === "/league-table") {
    if (method === "GET") {
      sendJson(res, 200, await service.getLeagueTable());
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // --- Champion -----------------------------------------------------------
  if (pathname === "/champion") {
    if (method === "POST") {
      const body = asObject(await readJsonBody(req));
      const result = await service.recordChampion(String(body.nationId ?? ""));
      sendCommandResult(res, result, ok);
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // --- Tournament-winner prize (status-style read) ------------------------
  if (pathname === "/prizes/tournament-winner") {
    if (method === "GET") {
      const result = await service.getTournamentWinner();
      sendStatusResult(res, result, (participant) => ({ winner: participant }));
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // --- League finalize ----------------------------------------------------
  if (pathname === "/league/finalize") {
    if (method === "POST") {
      const state: SweepstakeState = await service.finalizeLeague();
      sendJson(res, 200, { ok: true, leagueFinalized: state.leagueFinalized });
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // --- League prize (status-style read) -----------------------------------
  if (pathname === "/prizes/league") {
    if (method === "GET") {
      const result = await service.getLeaguePrize();
      sendStatusResult(res, result, (recipients) => ({ recipients }));
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // --- Unmatched route ----------------------------------------------------
  sendJson(res, 404, {
    code: "NOT_FOUND",
    message: `No route for ${method} ${pathname}.`,
  });
}

/** Write a `405 Method Not Allowed` JSON response. */
function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, {
    code: "METHOD_NOT_ALLOWED",
    message: "The HTTP method is not supported for this route.",
  });
}
