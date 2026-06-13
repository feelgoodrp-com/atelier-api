/**
 * Browser-session auth for the /admin web dashboard. Completely separate from
 * the desktop device-token flow:
 *   - a signed "admin-web" JWT rides in an HttpOnly cookie (12h),
 *   - access is gated on ATELIER_ADMIN_DISCORD_IDS (env) and RE-CHECKED on
 *     every request, so removing an ID from the env locks the dashboard out
 *     immediately (no waiting for the cookie to expire),
 *   - the OAuth round-trip is CSRF-protected by a signed state token bound to
 *     a nonce cookie (mirror of the desktop flow).
 *
 * Cookies are Secure only over https (ATELIER_PUBLIC_ORIGIN) so a loopback
 * http dev server still works. SameSite=Lax: the session cookie is sent on the
 * post-OAuth top-level redirect and on same-origin dashboard fetches, but NOT
 * on cross-site POST/PUT — which, together with the Origin check on mutations
 * (assertSameOrigin), blocks CSRF.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Env } from "../env";
import { signJwt, verifyJwt } from "./jwt";
import { isEnvAdmin } from "../models/atelierUser";
import { parseCookies } from "../http";

export const ADMIN_SESSION_COOKIE = "atelier_admin";
export const ADMIN_STATE_COOKIE = "atelier_admin_state";
const SESSION_TTL_SEC = 12 * 60 * 60; // 12h
const STATE_TTL_SEC = 600; // 10 min

interface AdminSessionClaims {
  typ: "admin-web";
  sub: string; // discordId
  username: string;
  avatar: string | null;
  iat: number;
  exp: number;
}

interface AdminStateClaims {
  typ: "admin-state";
  n: string; // nonce, bound to the browser via cookie
  exp: number;
}

export interface AdminWebSession {
  discordId: string;
  username: string;
  avatar: string | null;
}

function isHttps(env: Env): boolean {
  try {
    return new URL(env.ATELIER_PUBLIC_ORIGIN).protocol === "https:";
  } catch {
    return false;
  }
}

/** Shared cookie attributes; Secure only over https so loopback http works. */
function cookieAttrs(env: Env, extra: string): string {
  return `Path=/; HttpOnly; SameSite=Lax; ${isHttps(env) ? "Secure; " : ""}${extra}`;
}

export function adminCallbackUrl(env: Env): string {
  return `${env.ATELIER_PUBLIC_ORIGIN}/admin/callback`;
}

/* --------------------------------------------------------- session cookie */

export function signAdminSession(env: Env, s: AdminWebSession): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims: AdminSessionClaims = {
    typ: "admin-web",
    sub: s.discordId,
    username: s.username,
    avatar: s.avatar,
    iat,
    exp: iat + SESSION_TTL_SEC,
  };
  return signJwt(claims as unknown as Record<string, unknown>, env.ATELIER_JWT_SECRET);
}

export function setSessionCookie(env: Env, token: string): string {
  return `${ADMIN_SESSION_COOKIE}=${token}; ${cookieAttrs(env, `Max-Age=${SESSION_TTL_SEC}`)}`;
}

export function clearSessionCookie(env: Env): string {
  return `${ADMIN_SESSION_COOKIE}=; ${cookieAttrs(env, "Max-Age=0")}`;
}

/**
 * Verify the session cookie AND re-check the env-admin allowlist. Returns the
 * session or null. The allowlist re-check means a revoked admin loses access
 * on their very next request, regardless of the (still unexpired) cookie.
 */
export function readAdminSession(req: Request, env: Env): AdminWebSession | null {
  const token = parseCookies(req)[ADMIN_SESSION_COOKIE];
  if (!token) return null;
  const claims = verifyJwt<AdminSessionClaims>(token, env.ATELIER_JWT_SECRET);
  if (!claims || claims.typ !== "admin-web" || typeof claims.sub !== "string") return null;
  if (!isEnvAdmin(env, claims.sub)) return null;
  return {
    discordId: claims.sub,
    username: typeof claims.username === "string" ? claims.username : claims.sub,
    avatar: typeof claims.avatar === "string" ? claims.avatar : null,
  };
}

/* ------------------------------------------------------ OAuth state (CSRF) */

export function createAdminState(env: Env): { state: string; cookie: string } {
  const nonce = randomBytes(16).toString("hex");
  const claims: AdminStateClaims = {
    typ: "admin-state",
    n: nonce,
    exp: Math.floor(Date.now() / 1000) + STATE_TTL_SEC,
  };
  const state = signJwt(claims as unknown as Record<string, unknown>, env.ATELIER_JWT_SECRET);
  const cookie = `${ADMIN_STATE_COOKIE}=${nonce}; ${cookieAttrs(env, `Max-Age=${STATE_TTL_SEC}`)}`;
  return { state, cookie };
}

export function verifyAdminState(req: Request, env: Env, stateToken: string): boolean {
  const claims = verifyJwt<AdminStateClaims>(stateToken, env.ATELIER_JWT_SECRET);
  if (!claims || claims.typ !== "admin-state" || typeof claims.n !== "string") return false;
  const a = Buffer.from(parseCookies(req)[ADMIN_STATE_COOKIE] ?? "");
  const b = Buffer.from(claims.n);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function clearStateCookie(env: Env): string {
  return `${ADMIN_STATE_COOKIE}=; ${cookieAttrs(env, "Max-Age=0")}`;
}

/* ------------------------------------------------------------ CSRF on POST */

/**
 * Defense-in-depth for state-changing requests: when an Origin header is
 * present it must match ATELIER_PUBLIC_ORIGIN. (SameSite=Lax already withholds
 * the cookie on cross-site POST/PUT; this rejects same-cookie-but-wrong-origin
 * cases too.) Returns true when the request is allowed.
 */
export function isSameOrigin(req: Request, env: Env): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-CORS same-origin fetches may omit Origin
  return origin === env.ATELIER_PUBLIC_ORIGIN;
}
