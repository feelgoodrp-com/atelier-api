/**
 * atelierDevices — one document per logged-in desktop install.
 * Holds the rotating refresh token (sha256 hash only) and tokenVersion
 * used to invalidate outstanding access JWTs.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Env } from "../env";
import { col } from "../mongodb";
import { signAccessToken } from "./jwt";
import type { AtelierUser } from "../models/atelierUser";

export interface AtelierDevice {
  deviceId: string;
  discordId: string;
  name: string;
  platform: string;
  appVersion: string;
  createdAt: Date;
  lastSeenAt: Date;
  lastIp: string;
  refreshTokenHash: string;
  /** Hash of the previous (rotated-out) refresh token — used to detect token replay. */
  previousRefreshTokenHash: string | null;
  refreshExpiresAt: Date;
  tokenVersion: number;
  revokedAt: Date | null;
}

export interface DeviceInfo {
  name: string;
  platform: string;
  appVersion: string;
}

const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90d

export async function devicesCol() {
  return col<AtelierDevice>("atelierDevices");
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** 48 random bytes as hex (96 chars). Only the sha256 hash is stored. */
export function newRefreshToken(): string {
  return randomBytes(48).toString("hex");
}

export async function createDevice(
  discordId: string,
  info: DeviceInfo,
  ip: string,
): Promise<{ device: AtelierDevice; refreshToken: string }> {
  const devices = await devicesCol();
  const now = new Date();
  const refreshToken = newRefreshToken();
  const device: AtelierDevice = {
    deviceId: randomUUID(),
    discordId,
    name: info.name,
    platform: info.platform,
    appVersion: info.appVersion,
    createdAt: now,
    lastSeenAt: now,
    lastIp: ip,
    refreshTokenHash: sha256Hex(refreshToken),
    previousRefreshTokenHash: null,
    refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
    tokenVersion: 1,
    revokedAt: null,
  };
  await devices.insertOne(device);
  return { device, refreshToken };
}

/**
 * Atomic rotate (compare-and-swap on the presented token's hash):
 * only the request that still holds the CURRENT hash wins; a concurrent or
 * replayed request misses the filter and gets null. The old hash is kept in
 * previousRefreshTokenHash so replay attempts can be detected afterwards.
 */
export async function rotateRefreshTokenAtomic(
  presentedToken: string,
  ip: string,
): Promise<{ device: AtelierDevice; refreshToken: string } | null> {
  const devices = await devicesCol();
  const oldHash = sha256Hex(presentedToken);
  const refreshToken = newRefreshToken();
  const now = new Date();
  const device = await devices.findOneAndUpdate(
    { refreshTokenHash: oldHash, revokedAt: null, refreshExpiresAt: { $gt: now } },
    {
      $set: {
        refreshTokenHash: sha256Hex(refreshToken),
        previousRefreshTokenHash: oldHash,
        refreshExpiresAt: new Date(now.getTime() + REFRESH_TTL_MS),
        lastSeenAt: now,
        lastIp: ip,
      },
    },
    { returnDocument: "after" },
  );
  return device ? { device, refreshToken } : null;
}

/**
 * Replay detection: a token that matches a device's PREVIOUS hash was already
 * rotated out — someone is reusing a stale token (theft or a lost race).
 */
export async function findDeviceByReusedRefreshToken(
  presentedToken: string,
): Promise<AtelierDevice | null> {
  const devices = await devicesCol();
  return devices.findOne({
    previousRefreshTokenHash: sha256Hex(presentedToken),
    revokedAt: null,
  });
}

/** Revoke a single device and bump tokenVersion (kills outstanding access JWTs). */
export async function revokeDevice(deviceId: string): Promise<void> {
  const devices = await devicesCol();
  await devices.updateOne(
    { deviceId, revokedAt: null },
    { $set: { revokedAt: new Date() }, $inc: { tokenVersion: 1 } },
  );
}

/** Revoke all devices of a user (e.g. on lock). */
export async function revokeAllDevicesForUser(discordId: string): Promise<number> {
  const devices = await devicesCol();
  const result = await devices.updateMany(
    { discordId, revokedAt: null },
    { $set: { revokedAt: new Date() }, $inc: { tokenVersion: 1 } },
  );
  return result.modifiedCount;
}

export function issueAccessToken(env: Env, user: AtelierUser, device: AtelierDevice): string {
  return signAccessToken(
    {
      sub: user.discordId,
      discordId: user.discordId,
      username: user.username,
      avatar: user.avatar,
      deviceId: device.deviceId,
      tokenVersion: device.tokenVersion,
      role: user.role,
      status: user.status,
    },
    env.ATELIER_JWT_SECRET,
  );
}
