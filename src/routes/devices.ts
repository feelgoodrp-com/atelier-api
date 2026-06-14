/**
 * Device token lifecycle:
 *   POST /api/v1/auth/device/exchange  one-time code -> access JWT + refresh token
 *   POST /api/v1/auth/device/refresh   rotate refresh token, new access JWT
 *   POST /api/v1/auth/device/logout    revoke own device (bearer)
 *   GET  /api/v1/devices               list own devices (bearer, approved only)
 *   DELETE /api/v1/devices/:deviceId   revoke own device by id (bearer, approved only)
 */

import type { Router } from "../router";
import type { Env } from "../env";
import { json, err, readJsonBody, clientIp } from "../http";
import {
  createDevice,
  devicesCol,
  findDeviceByReusedRefreshToken,
  issueAccessToken,
  revokeDevice,
  rotateRefreshTokenAtomic,
  type AtelierDevice,
  type DeviceInfo,
} from "../auth/device-auth";
import { requireUser } from "../auth/require";
import { consumeAuthCode } from "../models/authCode";
import { getFreshUser, toPublicUser } from "../models/atelierUser";
import { logActivity } from "../models/activity";
import { RateLimiter } from "../http-rate-limit";

// Brute-force guard for the two unauthenticated token endpoints (per client IP).
const exchangeLimiter = new RateLimiter(20, 60_000);
const refreshLimiter = new RateLimiter(20, 60_000);

function parseDeviceInfo(raw: unknown): DeviceInfo {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const pick = (key: string, fallback: string, maxLen = 100): string => {
    const v = o[key];
    return typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, maxLen) : fallback;
  };
  return {
    name: pick("name", "Unnamed device"),
    platform: pick("platform", "unknown"),
    appVersion: pick("appVersion", "0.0.0"),
  };
}

function publicDevice(d: AtelierDevice, currentDeviceId?: string) {
  return {
    deviceId: d.deviceId,
    name: d.name,
    platform: d.platform,
    appVersion: d.appVersion,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt,
    lastIp: d.lastIp,
    current: d.deviceId === currentDeviceId,
  };
}

export function registerDeviceRoutes(router: Router, env: Env): void {
  // ------------------------------------------------------------ /exchange
  router.post("/api/v1/auth/device/exchange", async ({ req }) => {
    if (!exchangeLimiter.allow(clientIp(req))) return err("rate_limited", 429);
    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);
    const code = typeof body.code === "string" ? body.code : "";
    const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
    if (!code || !redirectUri) return err("code_and_redirect_uri_required", 400);

    const authCode = await consumeAuthCode(code, redirectUri);
    if (!authCode) return err("invalid_code", 400);

    const user = await getFreshUser(env, authCode.discordId);
    if (!user) return err("invalid_code", 400);

    const info = parseDeviceInfo(body.device);
    const { device, refreshToken } = await createDevice(user.discordId, info, clientIp(req));
    const accessToken = issueAccessToken(env, user, device);

    return json({
      accessToken,
      refreshToken,
      user: toPublicUser(user),
    });
  });

  // ------------------------------------------------------------- /refresh
  router.post("/api/v1/auth/device/refresh", async ({ req }) => {
    if (!refreshLimiter.allow(clientIp(req))) return err("rate_limited", 429);
    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);
    const refreshToken = typeof body.refreshToken === "string" ? body.refreshToken : "";
    if (!refreshToken) return err("refresh_token_required", 400);

    // Atomic compare-and-swap rotate: only the holder of the CURRENT hash wins.
    const rotated = await rotateRefreshTokenAtomic(refreshToken, clientIp(req));
    if (!rotated) {
      // Token matched a previous (already rotated-out) hash? That's a replay —
      // revoke the device so the stolen/raced token family dies entirely.
      const reused = await findDeviceByReusedRefreshToken(refreshToken);
      if (reused) {
        await revokeDevice(reused.deviceId);
        void logActivity("refresh_token_reuse", reused.discordId, {
          deviceId: reused.deviceId,
          ip: clientIp(req),
        });
      }
      return err("invalid_refresh_token", 401);
    }

    // Re-read the user so status/role changes apply on refresh.
    const { device } = rotated;
    const user = await getFreshUser(env, device.discordId);
    if (!user) {
      await revokeDevice(device.deviceId);
      return err("invalid_refresh_token", 401);
    }
    if (user.status === "locked") {
      await revokeDevice(device.deviceId);
      return err("locked", 403);
    }

    const accessToken = issueAccessToken(env, user, device);

    return json({
      accessToken,
      refreshToken: rotated.refreshToken,
      user: toPublicUser(user),
    });
  });

  // -------------------------------------------------------------- /logout
  router.post("/api/v1/auth/device/logout", async ({ req }) => {
    // Auth/device route: exempt from the pending gate.
    const auth = await requireUser(req, env, { allowPending: true });
    if (auth instanceof Response) return auth;
    await revokeDevice(auth.device.deviceId);
    void logActivity("device_logout", auth.user.discordId, { deviceId: auth.device.deviceId });
    return json({ ok: true });
  });

  // -------------------------------------------------------- GET /devices
  router.get("/api/v1/devices", async ({ req }) => {
    const auth = await requireUser(req, env); // pending gate applies
    if (auth instanceof Response) return auth;
    const devices = await devicesCol();
    const list = await devices
      .find({ discordId: auth.user.discordId, revokedAt: null })
      .sort({ lastSeenAt: -1 })
      .toArray();
    return json({ devices: list.map((d) => publicDevice(d, auth.device.deviceId)) });
  });

  // --------------------------------------------- DELETE /devices/:deviceId
  router.delete("/api/v1/devices/:deviceId", async ({ req, params }) => {
    const auth = await requireUser(req, env); // pending gate applies
    if (auth instanceof Response) return auth;
    const devices = await devicesCol();
    const target = await devices.findOne({
      deviceId: params.deviceId!,
      discordId: auth.user.discordId,
      revokedAt: null,
    });
    if (!target) return err("device_not_found", 404);
    await revokeDevice(target.deviceId); // sets revokedAt + bumps tokenVersion
    void logActivity("device_revoked", auth.user.discordId, { deviceId: target.deviceId });
    return json({ ok: true });
  });
}
