// Vercel serverless entry point for the multi-league API.
//
// Routes (all under /api/leagues handled here via vercel.json rewrite):
//   Global admin (Bearer token required):
//     POST   /api/leagues                      create { name, slug, password }
//     GET    /api/leagues                      list leagues
//     DELETE /api/leagues/{slug}               delete a league
//     POST   /api/leagues/{slug}/participants  add participant { name }
//     DELETE /api/leagues/{slug}/participants/{id}
//     POST   /api/leagues/{slug}/assign        run/replace draw { confirmReplace }
//     POST   /api/leagues/{slug}/finalize
//     POST   /api/tournament/nations           add nation { name }   (shared)
//     GET    /api/tournament/nations
//     DELETE /api/tournament/nations/{id}
//     POST   /api/tournament/matches           record { nationAId,... }
//     PUT    /api/tournament/matches           update
//     GET    /api/tournament/matches
//     POST   /api/tournament/champion          { nationId }
//   Public (per-league password):
//     POST   /api/leagues/{slug}/login         { password } -> sets cookie
//     GET    /api/leagues/{slug}/view          standings (cookie or token)
//
// Persistence is Neon-only (DATABASE_URL). Writes/admin require API_TOKEN.
// Viewing a league requires a signed cookie obtained via /login (or the token).

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { writeAuthorized } from "../src/auth.js";
import { createSeededRng } from "../src/main.js";
import { NeonLeagueRepository } from "../src/persistence/leagues.js";
import { LeagueService } from "../src/service/leagues.js";

let servicePromise: Promise<LeagueService> | null = null;

function getService(): Promise<LeagueService> {
  if (servicePromise === null) {
    servicePromise = (async () => {
      const url = process.env.DATABASE_URL;
      if (!url || url.trim().length === 0) {
        throw new Error("DATABASE_URL is required.");
      }
      const repo = await NeonLeagueRepository.create(url);
      return new LeagueService(repo, createSeededRng());
    })();
    servicePromise.catch(() => { servicePromise = null; });
  }
  return servicePromise;
}

// --- Helpers --------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  const parsed = JSON.parse(raw);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function tokenOk(req: IncomingMessage): boolean {
  // Authorize admin/write actions via either the bearer token (scripts) or the
  // admin session cookie (web UI login).
  return writeAuthorized(req.headers.authorization, req.headers.cookie);
}

/** Secret used to sign league view cookies. Falls back to API_TOKEN. */
function sessionSecret(): string {
  return process.env.SESSION_SECRET || process.env.API_TOKEN || "";
}

function signSlug(slug: string): string {
  return createHmac("sha256", sessionSecret()).update(slug).digest("hex");
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** A viewer is authorized for a league if they hold the admin token or a valid signed cookie. */
function viewerOk(req: IncomingMessage, slug: string): boolean {
  if (tokenOk(req)) return true;
  const cookie = parseCookies(req)[`league_${slug}`];
  if (!cookie) return false;
  const expected = signSlug(slug);
  const a = Buffer.from(cookie);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { code: "UNAUTHORIZED", message: "Admin token required." });
}

// --- Handler --------------------------------------------------------------

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let service: LeagueService;
  try {
    service = await getService();
  } catch (e) {
    console.error("League service init failed:", e);
    sendJson(res, 500, { code: "INITIALIZATION_ERROR", message: "Service failed to initialize. Check DATABASE_URL." });
    return;
  }

  try {
    await route(service, req, res);
  } catch (e) {
    if (e instanceof SyntaxError) { sendJson(res, 400, { code: "INVALID_JSON", message: "Body is not valid JSON." }); return; }
    console.error("League route error:", e);
    sendJson(res, 500, { code: "INTERNAL_ERROR", message: "An unexpected error occurred." });
  }
}

function segments(pathname: string): string[] {
  return pathname.replace(/^\/+|\/+$/g, "").split("/");
}

async function route(service: LeagueService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const seg = segments(url.pathname); // e.g. ["api","leagues","work","assign"]

  // Strip leading "api".
  if (seg[0] === "api") seg.shift();

  // --- Shared tournament management (admin) ------------------------------
  if (seg[0] === "tournament") {
    if (!tokenOk(req)) return unauthorized(res);
    const sub = seg[1];
    if (sub === "nations") {
      if (seg[2]) {
        if (method === "DELETE") return finish(res, await service.removeNation(decodeURIComponent(seg[2])));
        return methodNotAllowed(res);
      }
      if (method === "POST") { const b = await readBody(req); return finish(res, await service.addNation(String(b.name ?? ""))); }
      if (method === "GET") return sendJson(res, 200, await service.listNations());
      return methodNotAllowed(res);
    }
    if (sub === "matches") {
      if (method === "POST") { const b = await readBody(req); return finish(res, await service.recordMatch(toMatch(b))); }
      if (method === "PUT") { const b = await readBody(req); return finish(res, await service.updateMatch(toMatch(b))); }
      if (method === "DELETE") { const b = await readBody(req); return finish(res, await service.deleteMatch(String(b.nationAId ?? ""), String(b.nationBId ?? ""))); }
      if (method === "GET") return sendJson(res, 200, await service.listMatches());
      return methodNotAllowed(res);
    }
    if (sub === "champion") {
      if (method === "POST") { const b = await readBody(req); return finish(res, await service.recordChampion(String(b.nationId ?? ""))); }
      return methodNotAllowed(res);
    }
    if (sub === "knockout") {
      if (method === "GET") return sendJson(res, 200, await service.getKnockout());
      if (method === "PUT") {
        const b = await readBody(req);
        const a = b.nationAId == null || b.nationAId === "" ? null : String(b.nationAId);
        const bb = b.nationBId == null || b.nationBId === "" ? null : String(b.nationBId);
        return finishMaybe(res, await service.setKnockoutSlot(String(b.slotId ?? ""), a, bb));
      }
      return methodNotAllowed(res);
    }
    return notFound(res, method, url.pathname);
  }

  // --- Leagues -----------------------------------------------------------
  if (seg[0] === "leagues") {
    const slug = seg[1];

    // Collection: create / list (admin).
    if (!slug) {
      if (method === "POST") {
        if (!tokenOk(req)) return unauthorized(res);
        const b = await readBody(req);
        const r = await service.createLeague(String(b.name ?? ""), String(b.slug ?? ""), String(b.password ?? ""));
        if (r.ok) return sendJson(res, 200, { ok: true, slug: r.value.slug, name: r.value.name, url: `/l/${r.value.slug}` });
        return sendJson(res, r.error.code === "DUPLICATE_SLUG" ? 409 : 400, { code: r.error.code });
      }
      if (method === "GET") {
        if (!tokenOk(req)) return unauthorized(res);
        return sendJson(res, 200, await service.listLeagues());
      }
      return methodNotAllowed(res);
    }

    const action = seg[2];

    // Public: login to a league (sets a signed cookie).
    if (action === "login" && method === "POST") {
      const b = await readBody(req);
      const result = await service.checkPassword(slug, String(b.password ?? ""));
      if (typeof result !== "boolean") return notFoundLeague(res);
      if (!result) return sendJson(res, 401, { code: "BAD_PASSWORD", message: "Incorrect password." });
      const cookie = `league_${slug}=${signSlug(slug)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
      return sendJson(res, 200, { ok: true }, { "set-cookie": cookie });
    }

    // Public (password cookie, token, or link-only league): the standings view.
    if (action === "view" && method === "GET") {
      const needsPw = await service.requiresPassword(slug);
      if (typeof needsPw !== "boolean") return notFoundLeague(res);
      // Link-only leagues (no password) are viewable by anyone with the URL.
      if (needsPw && !viewerOk(req, slug)) {
        return sendJson(res, 401, { code: "LEAGUE_LOCKED", message: "Enter the league password." });
      }
      const view = await service.getView(slug);
      if (isNotFound(view)) return notFoundLeague(res);
      return sendJson(res, 200, view);
    }

    // Everything below is admin-only.
    if (!tokenOk(req)) return unauthorized(res);

    if (!action) {
      if (method === "DELETE") { await service.deleteLeague(slug); return sendJson(res, 200, { ok: true }); }
      return methodNotAllowed(res);
    }
    if (action === "participants") {
      if (seg[3]) {
        if (method === "DELETE") return finishMaybe(res, await service.removeParticipant(slug, decodeURIComponent(seg[3])));
        return methodNotAllowed(res);
      }
      if (method === "GET") {
        const r = await service.listParticipants(slug);
        if (isNotFound(r)) return notFoundLeague(res);
        return sendJson(res, 200, r);
      }
      if (method === "POST") { const b = await readBody(req); return finishMaybe(res, await service.addParticipant(slug, String(b.name ?? ""))); }
      return methodNotAllowed(res);
    }
    if (action === "assign" && method === "POST") {
      const b = await readBody(req);
      return finishMaybe(res, await service.assign(slug, b.confirmReplace === true));
    }
    if (action === "finalize" && method === "POST") {
      return finishMaybe(res, await service.finalize(slug));
    }
    if (action === "settings" && method === "GET") {
      const s = await service.getSettings(slug);
      if (isNotFound(s)) return notFoundLeague(res);
      return sendJson(res, 200, s);
    }
    if (action === "nations" && method === "PUT") {
      const b = await readBody(req);
      // body.nationIds: array of ids, or null/absent to allow all nations.
      const ids = Array.isArray(b.nationIds) ? b.nationIds.map((x) => String(x)) : null;
      return finishMaybe(res, await service.setIncludedNations(slug, ids));
    }
    return notFound(res, method, url.pathname);
  }

  return notFound(res, method, url.pathname);
}

// --- Response shaping -----------------------------------------------------

function toMatch(b: Record<string, unknown>) {
  return {
    nationAId: String(b.nationAId ?? ""),
    nationBId: String(b.nationBId ?? ""),
    goalsA: b.goalsA as number,
    goalsB: b.goalsB as number,
  };
}

function isNotFound(v: unknown): v is { code: "LEAGUE_NOT_FOUND" } {
  return typeof v === "object" && v !== null && (v as { code?: string }).code === "LEAGUE_NOT_FOUND";
}

const STATUS_FOR: Record<string, number> = {
  NAME_REQUIRED: 400, NAME_TOO_LONG: 400, NATIONS_NOT_DISTINCT: 400, GOALS_OUT_OF_RANGE: 400,
  DUPLICATE_PARTICIPANT: 409, DUPLICATE_NATION: 409, ASSIGNMENTS_EXIST: 409, CONFIRMATION_REQUIRED: 409,
  NO_PARTICIPANTS: 409, NO_NATIONS: 409, CHAMPION_NOT_ASSIGNED: 409,
  PARTICIPANT_NOT_FOUND: 404, MATCH_NOT_FOUND: 404, UNKNOWN_NATION: 404,
  CHAMPION_NOT_RECORDED: 409, LEAGUE_NOT_FINALIZED: 409,
};

/** Finish a domain Result (tournament-level). */
function finish(res: ServerResponse, result: { ok: boolean; error?: { code: string } }): void {
  if (result.ok) { sendJson(res, 200, { ok: true }); return; }
  const code = result.error?.code ?? "ERROR";
  sendJson(res, STATUS_FOR[code] ?? 400, { code });
}

/** Finish a per-league Result that may also be LEAGUE_NOT_FOUND. */
function finishMaybe(res: ServerResponse, result: unknown): void {
  if (isNotFound(result)) return notFoundLeague(res);
  finish(res, result as { ok: boolean; error?: { code: string } });
}

function notFoundLeague(res: ServerResponse): void {
  sendJson(res, 404, { code: "LEAGUE_NOT_FOUND", message: "No league with that link." });
}
function notFound(res: ServerResponse, method: string, path: string): void {
  sendJson(res, 404, { code: "NOT_FOUND", message: `No route for ${method} ${path}.` });
}
function methodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { code: "METHOD_NOT_ALLOWED", message: "Method not supported." });
}
