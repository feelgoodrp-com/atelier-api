/**
 * atelierUploads — resumable chunked upload sessions (one open session per
 * sha256 + user). The payload accumulates in tmpPath until /complete verifies
 * the hash and moves it into the CAS. Stale sessions die via the TTL index on
 * expiresAt (48h); their tmp files are cleaned up opportunistically.
 */

import { col } from "../mongodb";
import type { AssetKind } from "../storage/cas";

export type AtelierUploadStatus = "open" | "finalizing";

export interface AtelierUpload {
  uploadId: string;
  sha256Expected: string;
  size: number;
  kind: AssetKind;
  chunkSize: number;
  totalChunks: number;
  /** Chunk indices written so far (any order, no duplicates via $addToSet). */
  receivedChunks: number[];
  tmpPath: string;
  createdByDiscordId: string;
  deviceId: string;
  status: AtelierUploadStatus;
  createdAt: Date;
  expiresAt: Date;
}

export const UPLOAD_TTL_MS = 48 * 60 * 60 * 1000; // 48h

export async function uploadsCol() {
  return col<AtelierUpload>("atelierUploads");
}
