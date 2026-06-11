/**
 * atelierUsers collection — user accounts identified by Discord ID.
 * New users start as "pending" until an admin approves them,
 * except IDs listed in ATELIER_ADMIN_DISCORD_IDS which are always approved admins.
 */

import type { Env } from "../env";
import { col } from "../mongodb";

export type AtelierUserStatus = "pending" | "approved" | "locked";
export type AtelierUserRole = "admin" | "member";

export interface AtelierUser {
  discordId: string;
  username: string;
  avatar: string | null;
  status: AtelierUserStatus;
  role: AtelierUserRole;
  createdAt: Date;
  approvedByDiscordId?: string;
  approvedAt?: Date;
  lastLoginAt: Date;
}

export interface PublicUser {
  discordId: string;
  username: string;
  avatar: string | null;
  status: AtelierUserStatus;
  role: AtelierUserRole;
}

export function toPublicUser(user: AtelierUser): PublicUser {
  return {
    discordId: user.discordId,
    username: user.username,
    avatar: user.avatar,
    status: user.status,
    role: user.role,
  };
}

export function isEnvAdmin(env: Env, discordId: string): boolean {
  return env.ATELIER_ADMIN_DISCORD_IDS.includes(discordId);
}

export async function usersCol() {
  return col<AtelierUser>("atelierUsers");
}

/**
 * Upsert on login: refresh username/avatar/lastLoginAt, create as pending member,
 * force approved+admin for env-configured admin IDs.
 */
export async function upsertLoginUser(
  env: Env,
  discordId: string,
  username: string,
  avatar: string | null,
): Promise<AtelierUser> {
  const users = await usersCol();
  const now = new Date();

  const set: Partial<AtelierUser> = { username, avatar, lastLoginAt: now };
  const setOnInsert: Partial<AtelierUser> = { discordId, createdAt: now };

  if (isEnvAdmin(env, discordId)) {
    set.status = "approved";
    set.role = "admin";
  } else {
    setOnInsert.status = "pending";
    setOnInsert.role = "member";
  }

  const result = await users.findOneAndUpdate(
    { discordId },
    { $set: set, $setOnInsert: setOnInsert },
    { upsert: true, returnDocument: "after" },
  );
  if (!result) throw new Error("upsertLoginUser: findOneAndUpdate returned null");
  return result;
}

/**
 * Read a user and enforce the env-admin override (status approved + role admin).
 * Persists the override if the stored document drifted.
 */
export async function getFreshUser(env: Env, discordId: string): Promise<AtelierUser | null> {
  const users = await usersCol();
  const user = await users.findOne({ discordId });
  if (!user) return null;
  if (isEnvAdmin(env, discordId) && (user.status !== "approved" || user.role !== "admin")) {
    await users.updateOne({ discordId }, { $set: { status: "approved", role: "admin" } });
    user.status = "approved";
    user.role = "admin";
  }
  return user;
}
