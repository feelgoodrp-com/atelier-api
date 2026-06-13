/**
 * Reusable Discord OAuth helpers (scope: identify): authorize-URL builder,
 * code->token exchange and profile fetch.
 *
 * Used by the admin WEB login (routes/admin-web.ts). The desktop loopback flow
 * in routes/auth.ts keeps its own inline copy and is intentionally left
 * untouched — it is live and security-sensitive, so this extraction adds the
 * web flow without any risk of regressing the device login.
 */

import type { Env } from "../env";

export interface DiscordProfile {
  id: string;
  username: string;
  avatar: string | null;
}

export function discordAuthorizeUrl(env: Env, redirectUri: string, state: string): string {
  const u = new URL("https://discord.com/oauth2/authorize");
  u.searchParams.set("client_id", env.ATELIER_DISCORD_CLIENT_ID);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "identify");
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("state", state);
  u.searchParams.set("prompt", "none");
  return u.toString();
}

/** Exchange an authorization code for a Discord access token; null on failure. */
export async function exchangeDiscordCode(
  env: Env,
  code: string,
  redirectUri: string,
): Promise<string | null> {
  const res = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.ATELIER_DISCORD_CLIENT_ID,
      client_secret: env.ATELIER_DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { access_token?: string } | null;
  return body?.access_token ?? null;
}

/** Fetch the Discord profile for an access token (scope identify); null on failure. */
export async function fetchDiscordProfile(accessToken: string): Promise<DiscordProfile | null> {
  const res = await fetch("https://discord.com/api/users/@me", {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const me = (await res.json().catch(() => null)) as
    | { id?: string; username?: string; global_name?: string | null; avatar?: string | null }
    | null;
  if (!me?.id || !me.username) return null;
  return {
    id: me.id,
    username: me.global_name || me.username,
    avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png` : null,
  };
}
