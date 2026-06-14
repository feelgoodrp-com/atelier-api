/**
 * GET /api/v1/me — works for pending users (the desktop app needs this to
 * render the "Waiting for approval" screen).
 */

import type { Router } from "../router";
import type { Env } from "../env";
import { json } from "../http";
import { requireUser } from "../auth/require";
import { toPublicUser } from "../models/atelierUser";

export function registerMeRoutes(router: Router, env: Env): void {
  router.get("/api/v1/me", async ({ req }) => {
    const auth = await requireUser(req, env, { allowPending: true });
    if (auth instanceof Response) return auth;
    return json({
      user: {
        ...toPublicUser(auth.user),
        createdAt: auth.user.createdAt,
        lastLoginAt: auth.user.lastLoginAt,
      },
      device: {
        deviceId: auth.device.deviceId,
        name: auth.device.name,
      },
    });
  });
}
