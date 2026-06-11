/**
 * atelierPacks — shared clothing packs. The actual content lives in
 * atelierRevisions (immutable snapshots); headRevision 0 means "no revisions
 * yet". Deleting a pack archives it (archivedAt set) — never destroys data.
 *
 * Roles: the owner (creator) has full control, members are "editor"
 * (may PATCH + create revisions) or "viewer" (read-only). Global admins
 * bypass all pack role checks as if they were the owner.
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

/** Effective pack role for a user, or null when no access at all. */
export function packRoleFor(pack: AtelierPack, user: AtelierUser): PackAccessRole | null {
  if (user.role === "admin" || pack.ownerDiscordId === user.discordId) return "owner";
  const member = pack.members.find((m) => m.discordId === user.discordId);
  return member ? member.role : null;
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
