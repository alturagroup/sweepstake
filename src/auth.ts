// Shared write-authorization for the serverless API functions.
//
// Two ways to authorize a state-changing (write/admin) request:
//   1. Bearer token  — `Authorization: Bearer <API_TOKEN>`. Used by scripts and
//      backwards-compatible with the original design.
//   2. Admin session cookie — set by the password login. The admin web UI uses
//      this so users log in with a friendly password instead of pasting a token.
//
// Both are verified in constant time. Reads (GET/HEAD/OPTIONS) never require
// authorization; callers gate only writes.

import { createHmac, timingSafeEqual } from "node:crypto";

/** Secret used to sign the admin session cookie. Falls back to API_TOKEN. */
function sessionSecret(): string {
  return process.env.SESSION_SECRET || process.env.API_TOKEN || "";
}

/** Constant-time string compare that tolerates length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** The expected value of the admin_session cookie (HMAC of a fixed marker). */
export function adminCookieValue(): string {
  return createHmac("sha256", sessionSecret()).update("admin-session-v1").digest("hex");
}

/** Build the Set-Cookie header that establishes an admin session. */
export function adminCookieHeader(maxAgeSeconds = 2592000): string {
  return `admin_session=${adminCookieValue()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

/** Build the Set-Cookie header that clears the admin session. */
export function clearAdminCookieHeader(): string {
  return "admin_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

/** Parse a Cookie header into a map. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Whether the request carries a valid bearer token matching API_TOKEN. */
export function bearerOk(authHeader: string | undefined): boolean {
  const expected = process.env.API_TOKEN;
  if (!expected || expected.trim().length === 0) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader ?? "");
  const provided = m?.[1]?.trim();
  return provided !== undefined && safeEqual(provided, expected);
}

/** Whether the request carries a valid admin session cookie. */
export function adminCookieOk(cookieHeader: string | undefined): boolean {
  const secret = sessionSecret();
  if (secret.length === 0) return false;
  const value = parseCookies(cookieHeader).admin_session;
  return value !== undefined && safeEqual(value, adminCookieValue());
}

/** Authorized to perform a write/admin action via either token or session cookie. */
export function writeAuthorized(authHeader: string | undefined, cookieHeader: string | undefined): boolean {
  return bearerOk(authHeader) || adminCookieOk(cookieHeader);
}

/**
 * Verify a submitted admin password against ADMIN_PASSWORD. Fails closed when
 * ADMIN_PASSWORD is unset (so the login can never succeed unconfigured).
 */
export function checkAdminPassword(password: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || expected.trim().length === 0) return false;
  return safeEqual(password, expected);
}
