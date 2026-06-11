/**
 * atelierAuthCodes — one-time codes bridging the browser OAuth flow
 * to the desktop app (loopback redirect). TTL 60 seconds, single use.
 */

import { randomBytes } from "node:crypto";
import { col } from "../mongodb";

export interface AtelierAuthCode {
  code: string;
  discordId: string;
  redirectUri: string;
  createdAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
}

const CODE_TTL_MS = 60_000;

export async function authCodesCol() {
  return col<AtelierAuthCode>("atelierAuthCodes");
}

export async function createAuthCode(discordId: string, redirectUri: string): Promise<string> {
  const codes = await authCodesCol();
  const code = randomBytes(16).toString("hex"); // 32 hex chars
  const now = new Date();
  await codes.insertOne({
    code,
    discordId,
    redirectUri,
    createdAt: now,
    expiresAt: new Date(now.getTime() + CODE_TTL_MS),
    usedAt: null,
  });
  return code;
}

/**
 * Atomically consume a one-time code: must be unused, unexpired and match
 * the redirect URI it was issued for. Returns the code doc or null.
 */
export async function consumeAuthCode(code: string, redirectUri: string): Promise<AtelierAuthCode | null> {
  const codes = await authCodesCol();
  const now = new Date();
  return codes.findOneAndUpdate(
    { code, redirectUri, usedAt: null, expiresAt: { $gt: now } },
    { $set: { usedAt: now } },
    { returnDocument: "after" },
  );
}
