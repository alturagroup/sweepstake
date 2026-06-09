// Admin authentication endpoints (Vercel serverless).
//
// Handles the admin login/logout used by the web admin UI, so admins sign in
// with a friendly password instead of pasting the API_TOKEN. On success a
// signed HttpOnly session cookie is set; the league API accepts that cookie
// (or the bearer token) to authorize writes.
//
// Routes (mapped here via vercel.json):
//   POST /api/login    { password }  -> sets admin_session cookie
//   POST /api/logout                 -> clears the cookie
//   GET  /api/session                -> { authenticated: boolean }
//
// The old single-tenant sweepstake routes have been removed; the multi-league
// API (api/leagues.ts) is the live surface.

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  adminCookieHeader,
  adminCookieOk,
  checkAdminPassword,
  clearAdminCookieHeader,
} from "../src/auth.js";

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

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (path === "/api/login" && method === "POST") {
      if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.trim().length === 0) {
        sendJson(res, 503, { code: "AUTH_NOT_CONFIGURED", message: "Set ADMIN_PASSWORD to enable admin login." });
        return;
      }
      const body = await readBody(req);
      if (!checkAdminPassword(String(body.password ?? ""))) {
        sendJson(res, 401, { code: "BAD_PASSWORD", message: "Incorrect admin password." });
        return;
      }
      sendJson(res, 200, { ok: true }, { "set-cookie": adminCookieHeader() });
      return;
    }

    if (path === "/api/logout" && method === "POST") {
      sendJson(res, 200, { ok: true }, { "set-cookie": clearAdminCookieHeader() });
      return;
    }

    if (path === "/api/session" && method === "GET") {
      sendJson(res, 200, { authenticated: adminCookieOk(req.headers.cookie) });
      return;
    }

    sendJson(res, 404, { code: "NOT_FOUND", message: `No route for ${method} ${path}.` });
  } catch (e) {
    if (e instanceof SyntaxError) { sendJson(res, 400, { code: "INVALID_JSON", message: "Body is not valid JSON." }); return; }
    console.error("Auth handler error:", e);
    sendJson(res, 500, { code: "INTERNAL_ERROR", message: "An unexpected error occurred." });
  }
}
