/**
 * One-shot import of an existing creative cloth pack (ADMIN user lane):
 *   POST /api/v1/import/creative/:creativeProjectId
 *
 * Reads the creativeProjects + creativePackProjects collections (same Mongo
 * db) and the asset files below creative's CLOTH_UPLOAD_ROOT
 * (ATELIER_CREATIVE_CLOTH_ROOT here), hashes every file into the CAS and
 * creates a new pack with revision 1. Missing/unreadable files land in
 * `skipped` instead of failing the whole import.
 *
 * SLOT MAPPING DECISION: creative's componentIdFromKey (creative/lib/
 * cloth-gta-filename.ts) deviates from the canonical component order — it
 * maps teef->8 and accs->7 (canonically 7=teef, 8=accs) and task->5 (hand).
 * We translate componentId -> slot by CREATIVE'S semantics (7 -> accs,
 * 8 -> teef, 5 -> hand), so imported packs keep exactly the slot the
 * creative UI showed for each drawable. componentId 9 never occurs in
 * creative data but is mapped canonically (task) as a fallback.
 *
 * Gender: male by default — creative packs are male-ped only unless the
 * project scope says pedGender "female".
 */

import { randomUUID } from "node:crypto";
import { resolve, relative, isAbsolute, basename } from "node:path";
import { ObjectId } from "mongodb";
import type { Router } from "../router";
import type { Env } from "../env";
import { json, err } from "../http";
import { requireAdmin } from "../auth/require";
import { col } from "../mongodb";
import { casImportFile, type AssetKind } from "../storage/cas";
import { assetsCol } from "../models/atelierAsset";
import { packsCol, publicPack, uniqueActiveSlug, type AtelierPack } from "../models/atelierPack";
import {
  revisionsCol,
  type AtelierRevision,
  type RevisionAssetRef,
  type RevisionDrawable,
  type DrawableSlotType,
} from "../models/atelierRevision";
import { logActivity } from "../models/activity";

/** componentId -> slot, by CREATIVE's semantics (see header). */
const SLOT_BY_CREATIVE_COMPONENT_ID: Record<number, DrawableSlotType> = {
  0: "head",
  1: "berd",
  2: "hair",
  3: "uppr",
  4: "lowr",
  5: "hand",
  6: "feet",
  7: "accs", // creative: accs=7 (canonical would be teef)
  8: "teef", // creative: teef=8 (canonical would be accs)
  9: "task", // not produced by creative's mapper — canonical fallback
  10: "decl",
  11: "jbib",
};

/** Subset of creative's collections we read (see creative/lib/models/*). */
interface CreativeProjectDoc {
  _id: ObjectId;
  name: string;
  description?: string;
  scope?: { pedGender?: "male" | "female" | null };
}

interface CreativePackDrawable {
  id?: string;
  componentId?: number;
  drawableId?: number;
  label?: string;
  yddDiskPath?: string;
  ytdDiskPaths?: string[];
  exportYddName?: string;
  exportYtdNames?: string[];
  streamTag?: string;
}

interface CreativePackProjectDoc {
  projectId: ObjectId;
  resourceName: string;
  drawables: CreativePackDrawable[];
}

/**
 * Resolve a creative-relative posix path ({projectId}/assets/uuid.ext) below
 * the upload root — same traversal guards as creative's cloth-disk-storage.
 */
function resolveCreativeAsset(uploadRoot: string, relPosix: string): string | null {
  const normalized = relPosix.replace(/\\/gu, "/").replace(/^\/+/u, "");
  if (normalized === "" || normalized.includes("..")) return null;
  const full = resolve(uploadRoot, ...normalized.split("/"));
  const rel = relative(resolve(uploadRoot), full);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return full;
}

export function registerImportCreativeRoutes(router: Router, env: Env): void {
  router.post("/api/v1/import/creative/:creativeProjectId", async ({ req, params }) => {
    const auth = await requireAdmin(req, env);
    if (auth instanceof Response) return auth;

    const uploadRoot = env.ATELIER_CREATIVE_CLOTH_ROOT;
    if (uploadRoot === "") return err("creative_root_not_configured", 503);

    let projectId: ObjectId;
    try {
      projectId = new ObjectId(params.creativeProjectId!);
    } catch {
      return err("invalid_project_id", 400);
    }

    const projects = await col<CreativeProjectDoc>("creativeProjects");
    const project = await projects.findOne({ _id: projectId });
    if (!project) return err("creative_project_not_found", 404);

    const packProjects = await col<CreativePackProjectDoc>("creativePackProjects");
    const packProject = await packProjects.findOne({ projectId });
    if (!packProject) return err("creative_pack_not_found", 404);

    const gender: "male" | "female" = project.scope?.pedGender === "female" ? "female" : "male";
    const skipped: string[] = [];
    const importedShas = new Set<string>();
    const assets = await assetsCol();
    const now = new Date();

    /** Hash + copy one creative file into the CAS and upsert its asset doc. */
    const importAsset = async (
      relPath: string,
      kind: AssetKind,
      exportName: string,
    ): Promise<RevisionAssetRef | null> => {
      const abs = resolveCreativeAsset(uploadRoot, relPath);
      if (!abs || !(await Bun.file(abs).exists())) return null;
      const { sha256, size, diskPath } = await casImportFile(abs, kind);
      await assets.updateOne(
        { sha256 },
        {
          $setOnInsert: {
            sha256,
            size,
            kind,
            diskPath,
            refCount: 0,
            firstUploadedByDiscordId: auth.user.discordId,
            firstUploadedAt: now,
            lastReferencedAt: null,
          },
        },
        { upsert: true },
      );
      importedShas.add(sha256);
      return { sha256, size, exportName: exportName.slice(0, 200) };
    };

    const drawables: RevisionDrawable[] = [];
    for (const [i, d] of packProject.drawables.entries()) {
      const label = d.label?.trim() || d.exportYddName || `Drawable ${i + 1}`;

      if (!d.yddDiskPath) {
        skipped.push(`${label}: keine YDD-Datei hinterlegt`);
        continue;
      }
      const yddName =
        d.exportYddName && d.exportYddName.endsWith(".ydd")
          ? d.exportYddName
          : basename(d.yddDiskPath);
      const ydd = await importAsset(d.yddDiskPath, "ydd", yddName);
      if (!ydd) {
        skipped.push(`${label}: YDD-Datei fehlt auf der Festplatte (${d.yddDiskPath})`);
        continue;
      }

      const textures: RevisionAssetRef[] = [];
      for (const [t, rel] of (d.ytdDiskPaths ?? []).entries()) {
        const ytdName =
          d.exportYtdNames?.[t] && d.exportYtdNames[t]!.endsWith(".ytd")
            ? d.exportYtdNames[t]!
            : basename(rel);
        const tex = await importAsset(rel, "ytd", ytdName);
        if (tex) textures.push(tex);
        else skipped.push(`${label}: YTD-Datei fehlt auf der Festplatte (${rel})`);
      }

      const componentId = typeof d.componentId === "number" ? d.componentId : 11;
      drawables.push({
        id: d.id && d.id.length > 0 && d.id.length <= 64 ? d.id : randomUUID(),
        gender,
        kind: "component", // creative knows components only (no props)
        type: SLOT_BY_CREATIVE_COMPONENT_ID[componentId] ?? "jbib",
        mode: "addon",
        replaceTargetId: null,
        label: label.slice(0, 200),
        groupId: null,
        ydd,
        textures,
        physics: null,
        firstPerson: null,
        flags: { highHeels: false, hairScaleValue: null },
      });
    }

    if (drawables.length === 0) return json({ error: "nothing_to_import", skipped }, 400);

    // Pack + revision 1 in one go (headRevision starts at 1).
    const pack: AtelierPack = {
      packId: randomUUID(),
      name: project.name,
      slug: await uniqueActiveSlug(project.name),
      description: project.description?.trim().slice(0, 1000) ?? "",
      ownerDiscordId: auth.user.discordId,
      members: [],
      headRevision: 1,
      publish: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    const packs = await packsCol();
    await packs.insertOne({ ...pack });

    const shas = [...importedShas];
    const assetDocs = shas.length > 0 ? await assets.find({ sha256: { $in: shas } }).toArray() : [];
    const revision: AtelierRevision = {
      packId: pack.packId,
      revision: 1,
      parentRevision: 0,
      message: `Import aus creative (${packProject.resourceName})`,
      // No project settings exist for imports — builds fall back to the slug.
      dlcName: null,
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
    void logActivity("pack.imported_from_creative", auth.user.discordId, {
      packId: pack.packId,
      creativeProjectId: project._id.toHexString(),
      drawableCount: drawables.length,
      importedAssets: shas.length,
      skipped: skipped.length,
    });

    return json({
      pack: publicPack(pack),
      revision: { packId: revision.packId, revision: revision.revision, stats: revision.stats },
      importedAssets: shas.length,
      skipped,
    });
  });
}
