/**
 * Server-side build endpoints (user lane):
 *   POST /api/v1/packs/:packId/builds   { revision: number|"head" }  (editor+)
 *   GET  /api/v1/builds/:buildId                                     (member+)
 *   GET  /api/v1/builds/:buildId/artifact   ZIP stream               (member+)
 *
 * Revisions are immutable, so builds are cached per { packId, revision }:
 * an already-done build returns 200 with the cached document, anything that
 * (re)enters the queue returns 202. NOTE: server artifacts ship WITHOUT the
 * binary .ymt files — see src/cloth/fivem-export.ts (SERVER BUILD LIMITATION).
 */

import { stat } from "node:fs/promises";
import type { Router } from "../router";
import type { Env } from "../env";
import { json, err, readJsonBody } from "../http";
import { requireUser } from "../auth/require";
import { canEditPack } from "../models/atelierPack";
import { revisionsCol } from "../models/atelierRevision";
import { buildsCol, publicBuild, type AtelierBuild } from "../models/atelierBuild";
import { loadPackForUser } from "./packs";
import { ensureBuild } from "../builds/queue";

/** Stream a done build's artifact ZIP (shared with the registry download). */
export async function artifactResponse(build: AtelierBuild, downloadName: string): Promise<Response | null> {
  if (build.status !== "done" || !build.artifactPath) return null;
  const size = await stat(build.artifactPath).then((s) => (s.isFile() ? s.size : null)).catch(() => null);
  if (size == null) return null;
  return new Response(Bun.file(build.artifactPath), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-length": String(size),
      "content-disposition": `attachment; filename="${downloadName.replace(/[^a-zA-Z0-9._-]/gu, "_")}"`,
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}

export function registerBuildRoutes(router: Router, env: Env): void {
  // ------------------------------------------- POST /packs/:packId/builds
  router.post("/api/v1/packs/:packId/builds", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;
    if (!canEditPack(access.role)) return err("forbidden", 403);

    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);

    let revisionNo: number;
    if (body.revision === "head") {
      if (access.pack.headRevision === 0) return err("no_revisions", 404);
      revisionNo = access.pack.headRevision;
    } else if (typeof body.revision === "number" && Number.isInteger(body.revision) && body.revision >= 1) {
      revisionNo = body.revision;
    } else {
      return err("invalid_revision", 400);
    }

    const revisions = await revisionsCol();
    const exists = await revisions.findOne(
      { packId: access.pack.packId, revision: revisionNo },
      { projection: { revision: 1 } },
    );
    if (!exists) return err("revision_not_found", 404);

    const build = await ensureBuild(access.pack.packId, revisionNo, auth.user.discordId);
    return json({ build: publicBuild(build) }, build.status === "done" ? 200 : 202);
  });

  // --------------------------------------------------- GET /builds/:buildId
  router.get("/api/v1/builds/:buildId", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;

    const builds = await buildsCol();
    const build = await builds.findOne({ buildId: params.buildId! });
    if (!build) return err("build_not_found", 404);
    const access = await loadPackForUser(build.packId, auth.user);
    if (access instanceof Response) return access; // member+ (any role)

    return json({ build: publicBuild(build) });
  });

  // ------------------------------------------ GET /builds/:buildId/artifact
  router.get("/api/v1/builds/:buildId/artifact", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;

    const builds = await buildsCol();
    const build = await builds.findOne({ buildId: params.buildId! });
    if (!build) return err("build_not_found", 404);
    const access = await loadPackForUser(build.packId, auth.user);
    if (access instanceof Response) return access;

    const res = await artifactResponse(build, `${access.pack.slug}-r${build.revision}.zip`);
    if (!res) return err("build_not_done", 409);
    return res;
  });
}
