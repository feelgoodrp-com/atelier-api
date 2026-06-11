/**
 * Registry endpoints for the community websites (hub/webseite). SERVICE lane
 * only — header x-fg-service-token (requireService), NO user-lane auth.
 *
 *   GET /api/v1/registry/packs?target=&q=&page=&pageSize=   published list
 *   GET /api/v1/registry/packs/:idOrSlug                    detail + manifest
 *   GET /api/v1/registry/packs/:idOrSlug/download           artifact ZIP
 *
 * Listed = publish.visibility == "community" (a "private" publish delists)
 * on a non-archived pack. ?target filters on publish.targets membership.
 * Download streams the published revision's cached build — when no artifact
 * exists yet, the build is enqueued and 202 { build } returned (poll again).
 * NOTE: server artifacts ship without binary .ymt files — see
 * src/cloth/fivem-export.ts (SERVER BUILD LIMITATION).
 */

import type { Router } from "../router";
import type { Env } from "../env";
import { json, err } from "../http";
import { requireService } from "../auth/require";
import { packsCol, publicPack, type AtelierPack } from "../models/atelierPack";
import { revisionsCol } from "../models/atelierRevision";
import { publicBuild } from "../models/atelierBuild";
import { ensureBuild } from "../builds/queue";
import { artifactResponse } from "./builds";

const MAX_PAGE_SIZE = 100;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Filter matching every pack the registry exposes. */
function listedFilter(target: string | null): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    archivedAt: null,
    "publish.visibility": "community",
  };
  if (target) filter["publish.targets"] = target;
  return filter;
}

/** Resolve :idOrSlug to a LISTED pack (packId first, slug fallback). */
async function findListedPack(idOrSlug: string): Promise<AtelierPack | null> {
  const packs = await packsCol();
  return packs.findOne({
    ...listedFilter(null),
    $or: [{ packId: idOrSlug }, { slug: idOrSlug }],
  });
}

export function registerRegistryRoutes(router: Router, env: Env): void {
  // ----------------------------------------------------- GET /registry/packs
  router.get("/api/v1/registry/packs", async ({ req, url }) => {
    const fail = requireService(req, env);
    if (fail) return fail;

    const target = url.searchParams.get("target");
    const q = url.searchParams.get("q")?.trim() ?? "";
    const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
    const pageSizeRaw = Number(url.searchParams.get("pageSize") ?? "20") || 20;
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, pageSizeRaw));

    const filter = listedFilter(target);
    if (q !== "") {
      const re = new RegExp(escapeRegex(q), "iu");
      filter.$or = [{ name: re }, { slug: re }];
    }

    const packs = await packsCol();
    const total = await packs.countDocuments(filter);
    const list = await packs
      .find(filter)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .toArray();

    // drawableCount comes from the published revision's stats (one query).
    const pairs = list.map((p) => ({ packId: p.packId, revision: p.publish!.publishedRevision }));
    const revisions = await revisionsCol();
    const revDocs =
      pairs.length > 0
        ? await revisions
            .find({ $or: pairs }, { projection: { packId: 1, revision: 1, stats: 1 } })
            .toArray()
        : [];
    const countByPack = new Map(revDocs.map((r) => [`${r.packId}:${r.revision}`, r.stats.drawableCount]));

    return json({
      packs: list.map((p) => ({
        packId: p.packId,
        slug: p.slug,
        name: p.name,
        description: p.description,
        publishedRevision: p.publish!.publishedRevision,
        drawableCount: countByPack.get(`${p.packId}:${p.publish!.publishedRevision}`) ?? 0,
        updatedAt: p.updatedAt,
      })),
      total,
    });
  });

  // ------------------------------------------- GET /registry/packs/:idOrSlug
  router.get("/api/v1/registry/packs/:idOrSlug", async ({ req, params }) => {
    const fail = requireService(req, env);
    if (fail) return fail;

    const pack = await findListedPack(params.idOrSlug!);
    if (!pack) return err("pack_not_found", 404);

    const revisions = await revisionsCol();
    const revision = await revisions.findOne(
      { packId: pack.packId, revision: pack.publish!.publishedRevision },
      { projection: { _id: 0 } },
    );
    if (!revision) return err("revision_not_found", 404);

    return json({ pack: publicPack(pack), revision });
  });

  // ---------------------------------- GET /registry/packs/:idOrSlug/download
  router.get("/api/v1/registry/packs/:idOrSlug/download", async ({ req, params }) => {
    const fail = requireService(req, env);
    if (fail) return fail;

    const pack = await findListedPack(params.idOrSlug!);
    if (!pack) return err("pack_not_found", 404);

    const build = await ensureBuild(pack.packId, pack.publish!.publishedRevision, "service:registry");
    const res = await artifactResponse(build, `${pack.slug}-r${build.revision}.zip`);
    if (res) return res;
    if (build.status === "error") return json({ error: "build_failed", build: publicBuild(build) }, 500);
    return json({ build: publicBuild(build) }, 202);
  });
}
