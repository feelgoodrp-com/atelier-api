/**
 * Lightweight presence:
 *   POST   /api/v1/presence   heartbeat (every ~30s from the app) with the
 *                             currently open project (or null in the launcher)
 *   GET    /api/v1/presence   who is online (heartbeat within 90s) and where
 *   DELETE /api/v1/presence   explicit offline (app exit / logout)
 *
 * In-memory only — a service restart simply clears the list until the next
 * heartbeats arrive. One entry per user (multi-device: last write wins).
 */

import type { Router } from "../router";
import type { Env } from "../env";
import { json, err, readJsonBody } from "../http";
import { requireUser } from "../auth/require";

const ONLINE_WINDOW_MS = 90_000;

interface PresenceProject {
  id: string;
  name: string;
}

interface PresenceEntry {
  discordId: string;
  username: string;
  avatar: string | null;
  project: PresenceProject | null;
  updatedAt: number;
}

const presence = new Map<string, PresenceEntry>();

function prune(): void {
  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  for (const [discordId, entry] of presence) {
    if (entry.updatedAt < cutoff) presence.delete(discordId);
  }
}

function parseProject(raw: unknown): PresenceProject | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.name !== "string" || o.name.trim() === "") return null;
  return { id: o.id.slice(0, 64), name: o.name.trim().slice(0, 100) };
}

export function registerPresenceRoutes(router: Router, env: Env): void {
  router.post("/api/v1/presence", async ({ req }) => {
    const auth = await requireUser(req, env); // pending gate applies
    if (auth instanceof Response) return auth;
    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);
    presence.set(auth.user.discordId, {
      discordId: auth.user.discordId,
      username: auth.user.username,
      avatar: auth.user.avatar ?? null,
      project: parseProject(body.project),
      updatedAt: Date.now(),
    });
    return json({ ok: true });
  });

  router.get("/api/v1/presence", async ({ req }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    prune();
    const users = [...presence.values()]
      .sort((a, b) => a.username.localeCompare(b.username, "de"))
      .map((entry) => ({
        discordId: entry.discordId,
        username: entry.username,
        avatar: entry.avatar,
        project: entry.project,
        lastSeenAt: new Date(entry.updatedAt).toISOString(),
      }));
    return json({ users });
  });

  router.delete("/api/v1/presence", async ({ req }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    presence.delete(auth.user.discordId);
    return json({ ok: true });
  });
}
