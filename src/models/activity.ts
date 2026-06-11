/**
 * atelierActivity — append-only audit log for logins and admin actions.
 */

import { col } from "../mongodb";

export interface AtelierActivity {
  type: string;
  actorDiscordId: string;
  ts: Date;
  data: Record<string, unknown>;
}

export async function logActivity(
  type: string,
  actorDiscordId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  try {
    const activity = await col<AtelierActivity>("atelierActivity");
    await activity.insertOne({ type, actorDiscordId, ts: new Date(), data });
  } catch (e) {
    // Audit log must never break the actual request.
    console.error("[atelier-api] logActivity failed:", e);
  }
}
