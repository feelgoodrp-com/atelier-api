/**
 * Admin endpoints (role admin required). All mutations are logged to
 * atelierActivity { type, actorDiscordId, ts, data }.
 */

import type { Router } from "../router";
import type { Env } from "../env";
import { json, err, readJsonBody } from "../http";
import { requireAdmin } from "../auth/require";
import { usersCol, isEnvAdmin, type AtelierUser, type AtelierUserStatus } from "../models/atelierUser";
import { revokeAllDevicesForUser } from "../auth/device-auth";
import { logActivity } from "../models/activity";
import { kickUserEverywhere } from "../ws/collab";

const STATUSES: AtelierUserStatus[] = ["pending", "approved", "locked"];

function adminUserView(u: AtelierUser) {
  return {
    discordId: u.discordId,
    username: u.username,
    avatar: u.avatar,
    status: u.status,
    role: u.role,
    createdAt: u.createdAt,
    approvedByDiscordId: u.approvedByDiscordId ?? null,
    approvedAt: u.approvedAt ?? null,
    lastLoginAt: u.lastLoginAt,
  };
}

export function registerAdminRoutes(router: Router, env: Env): void {
  // ----------------------------------------------------- GET /admin/users
  router.get("/api/v1/admin/users", async ({ req, url }) => {
    const auth = await requireAdmin(req, env);
    if (auth instanceof Response) return auth;

    const status = url.searchParams.get("status");
    const filter: Record<string, unknown> = {};
    if (status) {
      if (!STATUSES.includes(status as AtelierUserStatus)) return err("invalid_status", 400);
      filter.status = status;
    }
    const users = await usersCol();
    const list = await users.find(filter).sort({ createdAt: -1 }).limit(500).toArray();
    return json({ users: list.map(adminUserView) });
  });

  // ------------------------------------------- POST /admin/users/:id/approve
  router.post("/api/v1/admin/users/:discordId/approve", async ({ req, params }) => {
    const auth = await requireAdmin(req, env);
    if (auth instanceof Response) return auth;

    const users = await usersCol();
    const result = await users.findOneAndUpdate(
      { discordId: params.discordId! },
      {
        $set: {
          status: "approved",
          approvedByDiscordId: auth.user.discordId,
          approvedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    if (!result) return err("user_not_found", 404);

    await logActivity("user_approved", auth.user.discordId, { discordId: result.discordId });
    return json({ user: adminUserView(result) });
  });

  // ---------------------------------------------- POST /admin/users/:id/lock
  router.post("/api/v1/admin/users/:discordId/lock", async ({ req, params }) => {
    const auth = await requireAdmin(req, env);
    if (auth instanceof Response) return auth;

    const discordId = params.discordId!;
    if (isEnvAdmin(env, discordId)) {
      // Env-configured admins would be force-unlocked on next login anyway.
      return err("cannot_lock_env_admin", 400);
    }

    const users = await usersCol();
    const result = await users.findOneAndUpdate(
      { discordId },
      { $set: { status: "locked" } },
      { returnDocument: "after" },
    );
    if (!result) return err("user_not_found", 404);

    const revokedDevices = await revokeAllDevicesForUser(discordId);
    // "Lock revokes everything" includes open collab sockets.
    await kickUserEverywhere(discordId);
    await logActivity("user_locked", auth.user.discordId, { discordId, revokedDevices });
    return json({ user: adminUserView(result), revokedDevices });
  });

  // ---------------------------------------------- POST /admin/users/:id/role
  router.post("/api/v1/admin/users/:discordId/role", async ({ req, params }) => {
    const auth = await requireAdmin(req, env);
    if (auth instanceof Response) return auth;

    const body = await readJsonBody(req);
    const role = body?.role;
    if (role !== "admin" && role !== "member") return err("invalid_role", 400);

    const discordId = params.discordId!;
    if (role === "member" && isEnvAdmin(env, discordId)) {
      return err("cannot_demote_env_admin", 400);
    }

    const users = await usersCol();
    const result = await users.findOneAndUpdate(
      { discordId },
      { $set: { role } },
      { returnDocument: "after" },
    );
    if (!result) return err("user_not_found", 404);

    await logActivity("user_role_changed", auth.user.discordId, { discordId, role });
    return json({ user: adminUserView(result) });
  });
}
