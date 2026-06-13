/**
 * atelierPacks — shared clothing packs. The actual content lives in
 * atelierRevisions (immutable snapshots); headRevision 0 means "no revisions
 * yet". Deleting a pack archives it (archivedAt set) — never destroys data.
 *
 * Roles (team-wide model): every approved user has "editor" access to ALL
 * packs by default (may PATCH + create revisions) — the whole team can
 * co-edit. An explicit member entry can DOWNGRADE a user to "viewer"
 * (read-only). The owner (creator) keeps full control (members/publish/
 * archive). Global admins bypass all pack role checks as if they were the
 * owner.
 */

import { col } from "../mongodb";
import type { AtelierUser } from "./atelierUser";

export type PackMemberRole = "editor" | "viewer";
export type PackAccessRole = "owner" | PackMemberRole;

export interface AtelierPackMember {
  discordId: string;
  role: PackMemberRole;
  addedAt: Date;
}

export type PackPublishVisibility = "private" | "community";

/**
 * Publish state (owner-only POST /publish). "community" lists the pack in the
 * service-lane registry for the community websites; "private" delists it
 * again. publishedRevision pins WHICH immutable revision is distributed.
 */
export interface AtelierPackPublish {
  visibility: PackPublishVisibility;
  /** Consumer targets, e.g. ["hub", "webseite"]. */
  targets: string[];
  publishedRevision: number;
  publishedAt: Date;
}

/**
 * Admin-only server-build overrides (set via the web dashboard). Affect ONLY
 * the server build of this pack; the desktop build is unaffected. Absent =
 * defaults (byte-identical fxmanifest, resource name = dlcName/slug).
 */
export interface AtelierPackBuildConfig {
  /** Override for the resource folder name (sanitized at build time). Empty = default. */
  resourceName?: string;
  /** Custom fxmanifest.lua template ({{files}}/{{data_files}} placeholders). Empty = default. */
  fxmanifestTemplate?: string;
  updatedAt: Date;
  updatedByDiscordId: string;
}

export interface AtelierPack {
  packId: string;
  name: string;
  slug: string;
  description: string;
  ownerDiscordId: string;
  members: AtelierPackMember[];
  /** 0 = no revisions yet. */
  headRevision: number;
  /** null = never published. */
  publish: AtelierPackPublish | null;
  /** Admin server-build overrides; absent/null = defaults. */
  buildConfig?: AtelierPackBuildConfig | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export async function packsCol() {
  return col<AtelierPack>("atelierPacks");
}

export function publicPack(p: AtelierPack) {
  return {
    packId: p.packId,
    name: p.name,
    slug: p.slug,
    description: p.description,
    ownerDiscordId: p.ownerDiscordId,
    members: p.members,
    headRevision: p.headRevision,
    // Older documents predate the publish feature — expose null uniformly.
    publish: p.publish ?? null,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    archivedAt: p.archivedAt,
  };
}

/**
 * Effective pack role for a user. Team-wide default: every approved user is
 * an "editor" on every pack. owner/admin keep full control; an explicit
 * member entry can downgrade a user to "viewer". Never returns null — access
 * gating happens upstream via requireUser (approved users only).
 */
export function packRoleFor(pack: AtelierPack, user: AtelierUser): PackAccessRole {
  if (user.role === "admin" || pack.ownerDiscordId === user.discordId) return "owner";
  const member = pack.members.find((m) => m.discordId === user.discordId);
  if (member) return member.role;
  return "editor"; // team default: every approved user may co-edit
}

export function canEditPack(role: PackAccessRole | null): boolean {
  return role === "owner" || role === "editor";
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "") // strip combining diacritics (ä -> a)
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return base || "pack";
}

/**
 * Pick a slug unique among NON-archived packs: base, base-2, base-3, ...
 * (slugify output is [a-z0-9-] only, so embedding it in a regex is safe).
 */
export async function uniqueActiveSlug(name: string): Promise<string> {
  const packs = await packsCol();
  const base = slugify(name);
  const existing = await packs
    .find({ slug: { $regex: `^${base}(-\\d+)?$` }, archivedAt: null }, { projection: { slug: 1 } })
    .toArray();
  const taken = new Set(existing.map((p) => p.slug));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
