/**
 * atelierRevisions — immutable snapshots of a pack's drawables
 * (unique index { packId, revision }). Asset references are CAS pointers
 * { sha256, size, exportName }; local file paths exist only in the client's
 * pack.atelier project file.
 *
 * parseRevisionDrawables() is the manual validator for POSTed revision
 * bodies — same zero-dependency style as the rest of the codebase.
 */

import { col } from "../mongodb";
import { isSha256Hex } from "../storage/cas";

export const DRAWABLE_SLOT_TYPES = [
  "head", "berd", "hair", "uppr", "lowr", "hand", "feet", "teef", "accs", "task", "decl", "jbib",
  "p_head", "p_eyes", "p_ears", "p_lwrist", "p_rwrist", "p_hip",
] as const;
export type DrawableSlotType = (typeof DRAWABLE_SLOT_TYPES)[number];

const MAX_DRAWABLES = 500;
const MAX_TEXTURES = 26; // letters a..z

export interface RevisionAssetRef {
  sha256: string;
  size: number;
  exportName: string;
}

export interface RevisionDrawable {
  id: string;
  gender: "male" | "female";
  kind: "component" | "prop";
  type: DrawableSlotType;
  mode: "addon" | "replace";
  replaceTargetId: number | null;
  label: string;
  groupId: string | null;
  ydd: RevisionAssetRef | null;
  /** Array order == texture letter a, b, c, ... */
  textures: RevisionAssetRef[];
  physics: RevisionAssetRef | null;
  firstPerson: RevisionAssetRef | null;
  flags: { highHeels: boolean; hairScaleValue: number | null };
}

export interface AtelierRevision {
  packId: string;
  revision: number;
  parentRevision: number;
  message: string;
  /**
   * DLC name from the pushing project's settings — server builds MUST use it
   * so stream names/YMT hashes match the desktop build of the same revision.
   * null on pre-Phase-3 revisions (server falls back to the pack slug).
   */
  dlcName: string | null;
  createdByDiscordId: string;
  deviceId: string;
  createdAt: Date;
  drawables: RevisionDrawable[];
  stats: { drawableCount: number; totalBytes: number };
}

export async function revisionsCol() {
  return col<AtelierRevision>("atelierRevisions");
}

type ParseResult<T> = { ok: T } | { error: string };

function parseAssetRef(v: unknown, field: string): ParseResult<RevisionAssetRef> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { error: `${field} must be an object` };
  }
  const o = v as Record<string, unknown>;
  const sha256 = typeof o.sha256 === "string" ? o.sha256.toLowerCase() : "";
  if (!isSha256Hex(sha256)) return { error: `${field}.sha256 must be 64 hex chars` };
  if (typeof o.size !== "number" || !Number.isInteger(o.size) || o.size < 1) {
    return { error: `${field}.size must be a positive integer` };
  }
  const exportName = typeof o.exportName === "string" ? o.exportName.trim() : "";
  if (exportName === "" || exportName.length > 200) {
    return { error: `${field}.exportName must be a non-empty string (max 200 chars)` };
  }
  return { ok: { sha256, size: o.size, exportName } };
}

function parseDrawable(v: unknown, field: string): ParseResult<RevisionDrawable> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    return { error: `${field} must be an object` };
  }
  const o = v as Record<string, unknown>;

  const id = typeof o.id === "string" ? o.id.trim() : "";
  if (id === "" || id.length > 64) return { error: `${field}.id must be a non-empty string (max 64 chars)` };

  if (o.gender !== "male" && o.gender !== "female") return { error: `${field}.gender must be male|female` };
  if (o.kind !== "component" && o.kind !== "prop") return { error: `${field}.kind must be component|prop` };
  if (typeof o.type !== "string" || !(DRAWABLE_SLOT_TYPES as readonly string[]).includes(o.type)) {
    return { error: `${field}.type must be one of ${DRAWABLE_SLOT_TYPES.join("|")}` };
  }
  // Contract parity with the app schema: p_* slots are props, the rest are
  // components — a mismatch would make the builders emit nonsense names.
  const isPropSlot = o.type.startsWith("p_");
  if ((o.kind === "prop") !== isPropSlot) {
    return { error: `${field}.type "${o.type}" does not match kind "${String(o.kind)}"` };
  }
  if (o.mode !== "addon" && o.mode !== "replace") return { error: `${field}.mode must be addon|replace` };

  const replaceTargetId = o.replaceTargetId ?? null;
  if (replaceTargetId !== null && (typeof replaceTargetId !== "number" || !Number.isInteger(replaceTargetId) || replaceTargetId < 0)) {
    return { error: `${field}.replaceTargetId must be null or a non-negative integer` };
  }
  // Contract parity with the app schema (schema.ts superRefine): a replace
  // drawable without a target is meaningless and must be rejected here too.
  if (o.mode === "replace" && replaceTargetId === null) {
    return { error: `${field}.replaceTargetId is required when mode is "replace"` };
  }

  if (typeof o.label !== "string" || o.label.length > 200) {
    return { error: `${field}.label must be a string (max 200 chars)` };
  }

  const groupId = o.groupId ?? null;
  if (groupId !== null && (typeof groupId !== "string" || groupId === "" || groupId.length > 64)) {
    return { error: `${field}.groupId must be null or a non-empty string (max 64 chars)` };
  }

  let ydd: RevisionAssetRef | null = null;
  if (o.ydd != null) {
    const parsed = parseAssetRef(o.ydd, `${field}.ydd`);
    if ("error" in parsed) return parsed;
    ydd = parsed.ok;
  }

  if (!Array.isArray(o.textures)) return { error: `${field}.textures must be an array` };
  if (o.textures.length > MAX_TEXTURES) return { error: `${field}.textures must have at most ${MAX_TEXTURES} entries` };
  const textures: RevisionAssetRef[] = [];
  for (let i = 0; i < o.textures.length; i++) {
    const parsed = parseAssetRef(o.textures[i], `${field}.textures[${i}]`);
    if ("error" in parsed) return parsed;
    textures.push(parsed.ok);
  }

  let physics: RevisionAssetRef | null = null;
  if (o.physics != null) {
    const parsed = parseAssetRef(o.physics, `${field}.physics`);
    if ("error" in parsed) return parsed;
    physics = parsed.ok;
  }

  let firstPerson: RevisionAssetRef | null = null;
  if (o.firstPerson != null) {
    const parsed = parseAssetRef(o.firstPerson, `${field}.firstPerson`);
    if ("error" in parsed) return parsed;
    firstPerson = parsed.ok;
  }

  const flags = o.flags;
  if (typeof flags !== "object" || flags === null || Array.isArray(flags)) {
    return { error: `${field}.flags must be an object` };
  }
  const f = flags as Record<string, unknown>;
  if (typeof f.highHeels !== "boolean") return { error: `${field}.flags.highHeels must be a boolean` };
  const hairScaleValue = f.hairScaleValue ?? null;
  if (hairScaleValue !== null && (typeof hairScaleValue !== "number" || !Number.isFinite(hairScaleValue))) {
    return { error: `${field}.flags.hairScaleValue must be null or a finite number` };
  }

  return {
    ok: {
      id,
      gender: o.gender,
      kind: o.kind,
      type: o.type as DrawableSlotType,
      mode: o.mode,
      replaceTargetId,
      label: o.label,
      groupId,
      ydd,
      textures,
      physics,
      firstPerson,
      flags: { highHeels: f.highHeels, hairScaleValue },
    },
  };
}

/** Validate + normalize a POSTed drawables array. */
export function parseRevisionDrawables(raw: unknown): ParseResult<RevisionDrawable[]> {
  if (!Array.isArray(raw)) return { error: "drawables must be an array" };
  if (raw.length > MAX_DRAWABLES) return { error: `drawables must have at most ${MAX_DRAWABLES} entries` };
  const out: RevisionDrawable[] = [];
  for (let i = 0; i < raw.length; i++) {
    const parsed = parseDrawable(raw[i], `drawables[${i}]`);
    if ("error" in parsed) return parsed;
    out.push(parsed.ok);
  }
  return { ok: out };
}

/** All distinct sha256s referenced by a drawables array (ydd, textures, physics, firstPerson). */
export function collectReferencedSha256s(drawables: RevisionDrawable[]): string[] {
  const shas = new Set<string>();
  for (const d of drawables) {
    if (d.ydd) shas.add(d.ydd.sha256);
    for (const t of d.textures) shas.add(t.sha256);
    if (d.physics) shas.add(d.physics.sha256);
    if (d.firstPerson) shas.add(d.firstPerson.sha256);
  }
  return [...shas];
}
