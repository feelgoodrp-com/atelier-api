/**
 * Minimal HS256 JWT sign/verify (no deps, node:crypto only).
 * Also used to sign the short-lived OAuth state token.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { AtelierUserRole, AtelierUserStatus } from "../models/atelierUser";

export interface AccessClaims {
  /** Token type discriminator — prevents cross-use with the OAuth state JWT. */
  typ: "access";
  sub: string; // discordId
  discordId: string;
  username: string;
  avatar: string | null;
  deviceId: string;
  tokenVersion: number;
  role: AtelierUserRole;
  status: AtelierUserStatus;
  iat: number;
  exp: number;
}

function b64u(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function hmac(data: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const header = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const sig = hmac(`${header}.${body}`, secret).toString("base64url");
  return `${header}.${body}.${sig}`;
}

/** Verify signature + exp claim. Returns payload or null. */
export function verifyJwt<T = Record<string, unknown>>(token: string, secret: string): T | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const expected = hmac(`${parts[0]}.${parts[1]}`, secret);
  let given: Buffer;
  try {
    given = Buffer.from(parts[2]!, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp === "number" && exp * 1000 < Date.now()) return null;
  return payload as T;
}

export const ACCESS_TOKEN_TTL_SEC = 60 * 60; // 1h

export function signAccessToken(
  input: Omit<AccessClaims, "typ" | "iat" | "exp">,
  secret: string,
): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims: AccessClaims = { ...input, typ: "access", iat, exp: iat + ACCESS_TOKEN_TTL_SEC };
  return signJwt(claims as unknown as Record<string, unknown>, secret);
}

export function verifyAccessToken(token: string, secret: string): AccessClaims | null {
  const claims = verifyJwt<AccessClaims>(token, secret);
  if (!claims) return null;
  if (
    claims.typ !== "access" ||
    typeof claims.sub !== "string" ||
    typeof claims.deviceId !== "string" ||
    typeof claims.tokenVersion !== "number"
  ) {
    return null;
  }
  return claims;
}
