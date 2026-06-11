/**
 * Pack + revision endpoints:
 *   POST   /api/v1/packs                                    create (any approved user)
 *   GET    /api/v1/packs                                    list own/member packs
 *   GET    /api/v1/packs/:packId                            single pack
 *   PATCH  /api/v1/packs/:packId                            rename/description (owner/editor)
 *   DELETE /api/v1/packs/:packId                            archive (owner)
 *   POST   /api/v1/packs/:packId/members                    add/replace member (owner)
 *   DELETE /api/v1/packs/:packId/members/:discordId         remove member (owner)
 *   GET    /api/v1/packs/:packId/revisions                  revision list (meta only)
 *   GET    /api/v1/packs/:packId/revisions/:rev/manifest    full doc (":rev" number or "head")
 *   POST   /api/v1/packs/:packId/revisions                  commit new head (owner/editor)
 *   POST   /api/v1/packs/:packId/publish                    publish to the registry (owner)
 *
 * Concurrency: a revision POST carries the baseRevision it was built on.
 * The head bump is an atomic findOneAndUpdate on { packId, headRevision:
 * baseRevision } — losers get 409 { error: "head_changed", head } and must
 * rebase client-side. Archived packs 404 everywhere.
 */

import { randomUUID } from "node:crypto";
import type { Router } from "../router";
import type { Env } from "../env";
import { json, err, readJsonBody } from "../http";
import { requireUser } from "../auth/require";
import { usersCol, type AtelierUser } from "../models/atelierUser";
import { assetsCol } from "../models/atelierAsset";
import {
  canEditPack,
  packRoleFor,
  packsCol,
  publicPack,
  uniqueActiveSlug,
  type AtelierPack,
  type AtelierPackPublish,
  type PackAccessRole,
} from "../models/atelierPack";
import {
  collectReferencedSha256s,
  parseRevisionDrawables,
  revisionsCol,
  type AtelierRevision,
} from "../models/atelierRevision";
import { logActivity } from "../models/activity";
import { broadcastToPack, kickFromPack } from "../ws/collab";

const MEMBER_ROLES = ["editor", "viewer"] as const;
const DISCORD_ID_RE = /^\d{5,25}$/u;
const PUBLISH_TARGET_RE = /^[a-z0-9_-]{1,32}$/u;
const MAX_PUBLISH_TARGETS = 10;

/** Load a non-archived pack and resolve the caller's role (404/403 as Response). */
export async function loadPackForUser(
  packId: string,
  user: AtelierUser,
): Promise<{ pack: AtelierPack; role: PackAccessRole } | Response> {
  const packs = await packsCol();
  const pack = await packs.findOne({ packId, archivedAt: null });
  if (!pack) return err("pack_not_found", 404);
  const role = packRoleFor(pack, user);
  if (!role) return err("forbidden", 403);
  return { pack, role };
}

export function registerPackRoutes(router: Router, env: Env): void {
  // ----------------------------------------------------------- POST /packs
  router.post("/api/v1/packs", async ({ req }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;

    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (name === "" || name.length > 100) return err("invalid_name", 400);
    const description =
      body.description === undefined
        ? ""
        : typeof body.description === "string"
          ? body.description.trim().slice(0, 1000)
          : null;
    if (description === null) return err("invalid_description", 400);

    const now = new Date();
    const pack: AtelierPack = {
      packId: randomUUID(),
      name,
      slug: await uniqueActiveSlug(name),
      description,
      ownerDiscordId: auth.user.discordId,
      members: [],
      headRevision: 0,
      publish: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    const packs = await packsCol();
    await packs.insertOne({ ...pack });
    void logActivity("pack.created", auth.user.discordId, { packId: pack.packId, name: pack.name });

    return json({ pack: publicPack(pack) });
  });

  // ------------------------------------------------------------ GET /packs
  router.get("/api/v1/packs", async ({ req }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;

    const me = auth.user.discordId;
    const filter =
      auth.user.role === "admin"
        ? { archivedAt: null }
        : { archivedAt: null, $or: [{ ownerDiscordId: me }, { "members.discordId": me }] };

    const packs = await packsCol();
    const list = await packs.find(filter).sort({ updatedAt: -1 }).limit(200).toArray();
    return json({ packs: list.map(publicPack) });
  });

  // ---------------------------------------------------- GET /packs/:packId
  router.get("/api/v1/packs/:packId", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;
    return json({ pack: publicPack(access.pack) });
  });

  // -------------------------------------------------- PATCH /packs/:packId
  router.patch("/api/v1/packs/:packId", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;
    if (!canEditPack(access.role)) return err("forbidden", 403);

    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);

    const updates: Partial<AtelierPack> = {};
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name === "" || name.length > 100) return err("invalid_name", 400);
      updates.name = name; // slug stays stable on rename
    }
    if (body.description !== undefined) {
      if (typeof body.description !== "string") return err("invalid_description", 400);
      updates.description = body.description.trim().slice(0, 1000);
    }
    if (Object.keys(updates).length === 0) return err("nothing_to_update", 400);

    const packs = await packsCol();
    const updated = await packs.findOneAndUpdate(
      { packId: access.pack.packId, archivedAt: null },
      { $set: { ...updates, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!updated) return err("pack_not_found", 404);
    return json({ pack: publicPack(updated) });
  });

  // ------------------------------------------------- DELETE /packs/:packId
  router.delete("/api/v1/packs/:packId", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;
    if (access.role !== "owner") return err("forbidden", 403);

    const packs = await packsCol();
    const now = new Date();
    await packs.updateOne(
      { packId: access.pack.packId, archivedAt: null },
      { $set: { archivedAt: now, updatedAt: now } },
    );
    void logActivity("pack.archived", auth.user.discordId, { packId: access.pack.packId });
    return json({ ok: true });
  });

  // -------------------------------------------- POST /packs/:packId/members
  router.post("/api/v1/packs/:packId/members", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;
    if (access.role !== "owner") return err("forbidden", 403);

    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);
    const discordId = typeof body.discordId === "string" ? body.discordId.trim() : "";
    if (!DISCORD_ID_RE.test(discordId)) return err("invalid_discord_id", 400);
    const role = body.role;
    if (role !== "editor" && role !== "viewer") {
      return err(`role must be ${MEMBER_ROLES.join("|")}`, 400);
    }
    if (discordId === access.pack.ownerDiscordId) return err("cannot_add_owner", 400);

    const users = await usersCol();
    if (!(await users.findOne({ discordId }))) return err("user_not_found", 404);

    // Replace any existing entry, then push the new one (role change = re-add).
    const packs = await packsCol();
    const now = new Date();
    await packs.updateOne({ packId: access.pack.packId }, { $pull: { members: { discordId } } });
    const updated = await packs.findOneAndUpdate(
      { packId: access.pack.packId, archivedAt: null },
      { $push: { members: { discordId, role, addedAt: now } }, $set: { updatedAt: now } },
      { returnDocument: "after" },
    );
    if (!updated) return err("pack_not_found", 404);
    void logActivity("pack.member_added", auth.user.discordId, {
      packId: access.pack.packId,
      discordId,
      role,
    });
    return json({ pack: publicPack(updated) });
  });

  // --------------------------------- DELETE /packs/:packId/members/:discordId
  router.delete("/api/v1/packs/:packId/members/:discordId", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;
    if (access.role !== "owner") return err("forbidden", 403);

    const discordId = params.discordId!;
    if (!access.pack.members.some((m) => m.discordId === discordId)) {
      return err("member_not_found", 404);
    }

    const packs = await packsCol();
    const updated = await packs.findOneAndUpdate(
      { packId: access.pack.packId, archivedAt: null },
      { $pull: { members: { discordId } }, $set: { updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!updated) return err("pack_not_found", 404);
    // Immediately drop the removed member's open collab sockets for this pack
    // (the periodic revalidation sweep is only the backstop).
    await kickFromPack(access.pack.packId, discordId);
    void logActivity("pack.member_removed", auth.user.discordId, {
      packId: access.pack.packId,
      discordId,
    });
    return json({ pack: publicPack(updated) });
  });

  // ------------------------------------------ GET /packs/:packId/revisions
  router.get("/api/v1/packs/:packId/revisions", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;

    const revisions = await revisionsCol();
    const list = await revisions
      .find({ packId: access.pack.packId }, { projection: { _id: 0, drawables: 0 } })
      .sort({ revision: -1 })
      .toArray();
    return json({ revisions: list });
  });

  // ----------------------------- GET /packs/:packId/revisions/:rev/manifest
  router.get("/api/v1/packs/:packId/revisions/:rev/manifest", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;

    let revisionNo: number;
    if (params.rev === "head") {
      if (access.pack.headRevision === 0) return err("no_revisions", 404);
      revisionNo = access.pack.headRevision;
    } else {
      revisionNo = Number(params.rev);
      if (!/^\d+$/u.test(params.rev!) || !Number.isInteger(revisionNo) || revisionNo < 1) {
        return err("invalid_revision", 400);
      }
    }

    const revisions = await revisionsCol();
    const doc = await revisions.findOne(
      { packId: access.pack.packId, revision: revisionNo },
      { projection: { _id: 0 } },
    );
    if (!doc) return err("revision_not_found", 404);
    return json({ revision: doc });
  });

  // ----------------------------------------- POST /packs/:packId/revisions
  router.post("/api/v1/packs/:packId/revisions", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;
    if (!canEditPack(access.role)) return err("forbidden", 403);

    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);

    const baseRevision = body.baseRevision;
    if (typeof baseRevision !== "number" || !Number.isInteger(baseRevision) || baseRevision < 0) {
      return err("invalid_base_revision", 400);
    }
    const message = typeof body.message === "string" ? body.message.trim().slice(0, 500) : "";
    // DLC name from the pushing project — server builds must use the same
    // name as desktop builds or stream names/YMT hashes diverge.
    const dlcNameRaw = typeof body.dlcName === "string" ? body.dlcName.trim().toLowerCase() : "";
    const dlcName = /^[a-z0-9_]{1,32}$/u.test(dlcNameRaw) ? dlcNameRaw : null;

    const parsed = parseRevisionDrawables(body.drawables);
    if ("error" in parsed) return err(parsed.error, 400);
    const drawables = parsed.ok;

    // Every referenced asset must already live in the CAS.
    const shas = collectReferencedSha256s(drawables);
    const assets = await assetsCol();
    const assetDocs =
      shas.length > 0 ? await assets.find({ sha256: { $in: shas } }).toArray() : [];
    const presentShas = new Set(assetDocs.map((a) => a.sha256));
    const missing = shas.filter((s) => !presentShas.has(s));
    if (missing.length > 0) return json({ error: "missing_assets", missing }, 400);

    // Atomic head bump — only succeeds when the head still equals baseRevision.
    const packs = await packsCol();
    const now = new Date();
    const bumped = await packs.findOneAndUpdate(
      { packId: access.pack.packId, headRevision: baseRevision, archivedAt: null },
      { $set: { headRevision: baseRevision + 1, updatedAt: now } },
      { returnDocument: "after" },
    );
    if (!bumped) {
      const current = await packs.findOne({ packId: access.pack.packId, archivedAt: null });
      if (!current) return err("pack_not_found", 404);
      const revisions = await revisionsCol();
      const head =
        current.headRevision > 0
          ? await revisions.findOne(
              { packId: current.packId, revision: current.headRevision },
              { projection: { _id: 0 } },
            )
          : null;
      return json({ error: "head_changed", head }, 409);
    }

    const revision: AtelierRevision = {
      packId: access.pack.packId,
      revision: baseRevision + 1,
      parentRevision: baseRevision,
      message,
      dlcName,
      createdByDiscordId: auth.user.discordId,
      deviceId: auth.device.deviceId,
      createdAt: now,
      drawables,
      stats: {
        drawableCount: drawables.length,
        totalBytes: assetDocs.reduce((sum, a) => sum + a.size, 0),
      },
    };
    const revisions = await revisionsCol();
    await revisions.insertOne({ ...revision });

    if (shas.length > 0) {
      await assets.updateMany(
        { sha256: { $in: shas } },
        { $inc: { refCount: 1 }, $set: { lastReferencedAt: now } },
      );
    }
    void logActivity("revision.created", auth.user.discordId, {
      packId: revision.packId,
      revision: revision.revision,
      drawableCount: revision.stats.drawableCount,
      totalBytes: revision.stats.totalBytes,
    });
    broadcastToPack(revision.packId, {
      type: "head-changed",
      revision: revision.revision,
      byDiscordId: auth.user.discordId,
    });

    return json({ revision });
  });

  // ------------------------------------------- POST /packs/:packId/publish
  // Owner-only. "community" lists the pack in the service-lane registry,
  // "private" delists it. publishedRevision pins the distributed snapshot.
  router.post("/api/v1/packs/:packId/publish", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;
    const access = await loadPackForUser(params.packId!, auth.user);
    if (access instanceof Response) return access;
    if (access.role !== "owner") return err("forbidden", 403);

    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);

    const visibility = body.visibility;
    if (visibility !== "private" && visibility !== "community") return err("invalid_visibility", 400);

    if (!Array.isArray(body.targets) || body.targets.length > MAX_PUBLISH_TARGETS) {
      return err("invalid_targets", 400);
    }
    const targets: string[] = [];
    for (const t of body.targets) {
      if (typeof t !== "string" || !PUBLISH_TARGET_RE.test(t)) return err("invalid_targets", 400);
      if (!targets.includes(t)) targets.push(t);
    }

    const revision = body.revision;
    if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
      return err("invalid_revision", 400);
    }
    const revisions = await revisionsCol();
    const exists = await revisions.findOne(
      { packId: access.pack.packId, revision },
      { projection: { revision: 1 } },
    );
    if (!exists) return err("revision_not_found", 404);

    const publish: AtelierPackPublish = {
      visibility,
      targets,
      publishedRevision: revision,
      publishedAt: new Date(),
    };
    const packs = await packsCol();
    const updated = await packs.findOneAndUpdate(
      { packId: access.pack.packId, archivedAt: null },
      { $set: { publish, updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (!updated) return err("pack_not_found", 404);

    void logActivity("pack.published", auth.user.discordId, {
      packId: access.pack.packId,
      visibility,
      targets,
      revision,
    });
    return json({ pack: publicPack(updated) });
  });
}
