/**
 * atelierBuilds — server-side FiveM resource builds of pack revisions.
 *
 * Revisions are immutable, so a build is fully determined by { packId,
 * revision } (unique index): the first request enqueues, every later request
 * returns the cached document/artifact. A failed build is re-enqueued in
 * place. Artifacts live at <ATELIER_STORAGE_ROOT>/builds/<packId>/<revision>.zip.
 *
 * SERVER BUILD LIMITATION: binary CPedVariationInfo .ymt files require
 * CodeWalker (.NET) and can only be produced by the desktop sidecar build.
 * Server artifacts therefore ship WITHOUT real .ymt files — see
 * src/cloth/fivem-export.ts for the full documentation of the placeholder.
 */

import { col } from "../mongodb";

export type AtelierBuildStatus = "queued" | "running" | "done" | "error";

export interface AtelierBuildReportResource {
  folder: string;
  drawables: number;
}

export interface AtelierBuildReport {
  resources: AtelierBuildReportResource[];
  warnings: string[];
}

export interface AtelierBuild {
  buildId: string;
  packId: string;
  revision: number;
  status: AtelierBuildStatus;
  /** Set when status == "error". */
  error: string | null;
  /** Artifact ZIP size, set when status == "done". */
  sizeBytes: number | null;
  /** Absolute path of the artifact ZIP (set when status == "done"). */
  artifactPath: string | null;
  report: AtelierBuildReport | null;
  requestedByDiscordId: string;
  /** Number of build runs so far — caps error-retry churn (see queue.ts). */
  attempts: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export async function buildsCol() {
  return col<AtelierBuild>("atelierBuilds");
}

export function publicBuild(b: AtelierBuild) {
  return {
    buildId: b.buildId,
    packId: b.packId,
    revision: b.revision,
    status: b.status,
    ...(b.error != null ? { error: b.error } : {}),
    ...(b.sizeBytes != null ? { sizeBytes: b.sizeBytes } : {}),
    ...(b.report != null ? { report: b.report } : {}),
    ...(b.finishedAt != null ? { finishedAt: b.finishedAt } : {}),
  };
}
