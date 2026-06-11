/**
 * Auth middleware helpers. Each returns either a context object on success
 * or a ready-to-send error Response (check with `instanceof Response`).
 *
 * PENDING GATE: every /api/v1/* endpoint must use requireUser() WITHOUT
 * allowPending — only /api/v1/me and the auth/device routes pass
 * { allowPending: true }. Non-approved users get:
 *   status "pending" -> 403 { error: "pending_approval" }
 *   status "locked"  -> 403 { error: "locked" }
 */

import { timingSafeEqual } from "node:crypto";
import type { Env } from "../env";
import { err } from "../http";
import { verifyAccessToken, type AccessClaims } from "./jwt";
import { devicesCol, type AtelierDevice } from "./device-auth";
import { getFreshUser, type AtelierUser } from "../models/atelierUser";

export interface AuthedContext {
  user: AtelierUser;
  device: AtelierDevice;
  claims: AccessClaims;
}

export interface RequireUserOptions {
  /** Allow status pending/locked through (only /api/v1/me + auth/device routes). */
  allowPending?: boolean;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}

export async function requireUser(
  req: Request,
  env: Env,
  opts: RequireUserOptions = {},
): Promise<AuthedContext | Response> {
  return requireUserFromToken(bearerToken(req), env, opts);
}

/**
 * Same checks as requireUser, but with a raw access token instead of the
 * Authorization header — used by the WebSocket upgrade (?token=...).
 */
export async function requireUserFromToken(
  token: string | null,
  env: Env,
  opts: RequireUserOptions = {},
): Promise<AuthedContext | Response> {
  if (!token) return err("unauthorized", 401);

  const claims = verifyAccessToken(token, env.ATELIER_JWT_SECRET);
  if (!claims) return err("unauthorized", 401);

  // Device must still exist, not be revoked, and the tokenVersion must match —
  // bumping tokenVersion (logout/revoke/lock) invalidates all outstanding JWTs.
  const devices = await devicesCol();
  const device = await devices.findOne({ deviceId: claims.deviceId });
  if (!device || device.revokedAt != null || device.tokenVersion !== claims.tokenVersion) {
    return err("unauthorized", 401);
  }

  // Always read the user fresh from Mongo so approvals/locks apply immediately.
  const user = await getFreshUser(env, claims.sub);
  if (!user) return err("unauthorized", 401);

  if (!opts.allowPending && user.status !== "approved") {
    return user.status === "locked" ? err("locked", 403) : err("pending_approval", 403);
  }

  // Best-effort presence update (not awaited on purpose).
  void devices
    .updateOne({ deviceId: device.deviceId }, { $set: { lastSeenAt: new Date() } })
    .catch(() => {});

  return { user, device, claims };
}

export async function requireAdmin(req: Request, env: Env): Promise<AuthedContext | Response> {
  const auth = await requireUser(req, env);
  if (auth instanceof Response) return auth;
  if (auth.user.role !== "admin") return err("forbidden", 403);
  return auth;
}

/**
 * Service-to-service auth via header x-fg-service-token.
 * Returns null when OK, otherwise an error Response.
 * (Used later by the registry/build pipeline.)
 */
export function requireService(req: Request, env: Env): Response | null {
  const given = req.headers.get("x-fg-service-token") ?? "";
  const expected = env.ATELIER_SERVICE_TOKEN;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return err("unauthorized", 401);
  }
  return null;
}
