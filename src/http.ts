/** Small HTTP helpers shared by all routes. */

const JSON_HDR = { "content-type": "application/json; charset=utf-8" };

export function json(body: unknown, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: extraHeaders ? { ...JSON_HDR, ...extraHeaders } : JSON_HDR,
  });
}

/** Error convention: { "error": "message" } */
export function err(message: string, status: number): Response {
  return json({ error: message }, status);
}

export function redirect(location: string, extraHeaders?: Record<string, string>): Response {
  return new Response(null, {
    status: 302,
    headers: { location, ...(extraHeaders ?? {}) },
  });
}

/** Safely parse a JSON request body; returns null on invalid/missing JSON. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parse the Cookie header into a name -> value map. */
export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.get("cookie");
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

/**
 * Socket peer addresses, recorded per request by the server entrypoint
 * (Bun.serve's `server.requestIP`). WeakMap so entries die with the request.
 */
const socketIps = new WeakMap<Request, string>();
let trustProxyHeaders = false;

/** Called once at startup (from index.ts) with ATELIER_TRUST_PROXY. */
export function configureClientIp(trustProxy: boolean): void {
  trustProxyHeaders = trustProxy;
}

/** Called by the server entrypoint for every request. */
export function recordSocketIp(req: Request, ip: string | null | undefined): void {
  if (ip) socketIps.set(req, ip);
}

/**
 * Client IP for rate limiting / audit logs.
 *
 * SECURITY: X-Forwarded-For is attacker-controlled on direct connections —
 * trusting it lets every client pick its own rate-limit bucket. It is only
 * honored when ATELIER_TRUST_PROXY=1 (deployment behind a reverse proxy),
 * and then the RIGHTMOST entry is used (appended by our own proxy).
 * Otherwise: the actual socket peer address.
 */
export function clientIp(req: Request): string {
  const socketIp = socketIps.get(req) ?? "";
  if (!trustProxyHeaders) return socketIp;
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const parts = fwd.split(",");
    const last = parts[parts.length - 1]?.trim();
    if (last) return last;
  }
  return socketIp;
}

/**
 * Validate that a redirect URI is a loopback URL:
 * http://127.0.0.1:<port>/... or http://localhost:<port>/...
 */
export function isLoopbackRedirectUri(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "http:") return false;
  return u.hostname === "127.0.0.1" || u.hostname === "localhost";
}
