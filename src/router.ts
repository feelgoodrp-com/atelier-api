/**
 * Tiny method+path router with :param support. Zero dependencies.
 *
 * Usage:
 *   const r = new Router();
 *   r.get("/api/v1/devices/:deviceId", (ctx) => json({ id: ctx.params.deviceId }));
 *   const res = await r.handle(req, url);
 */

import type { Env } from "./env";

export interface RouteContext {
  req: Request;
  url: URL;
  params: Record<string, string>;
  env: Env;
}

export type RouteHandler = (ctx: RouteContext) => Response | Promise<Response>;

interface CompiledRoute {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export class Router {
  private routes: CompiledRoute[] = [];

  constructor(private env: Env) {}

  on(method: string, path: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), segments: splitPath(path), handler });
    return this;
  }

  get(path: string, handler: RouteHandler): this {
    return this.on("GET", path, handler);
  }

  post(path: string, handler: RouteHandler): this {
    return this.on("POST", path, handler);
  }

  put(path: string, handler: RouteHandler): this {
    return this.on("PUT", path, handler);
  }

  patch(path: string, handler: RouteHandler): this {
    return this.on("PATCH", path, handler);
  }

  delete(path: string, handler: RouteHandler): this {
    return this.on("DELETE", path, handler);
  }

  match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    const parts = splitPath(pathname);
    outer: for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i]!;
        if (seg.startsWith(":")) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]!);
        } else if (seg !== parts[i]) {
          continue outer;
        }
      }
      return { handler: route.handler, params };
    }
    return null;
  }

  /** Returns null when no route matches (caller decides on 404). */
  async handle(req: Request, url: URL): Promise<Response | null> {
    const matched = this.match(req.method, url.pathname);
    if (!matched) return null;
    return matched.handler({ req, url, params: matched.params, env: this.env });
  }
}
