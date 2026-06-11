/**
 * atelierAssets — one document per content-addressed file in the CAS.
 * sha256 is the identity (unique index); refCount counts how many pack
 * revisions reference the asset (bumped on revision create).
 */

import { col } from "../mongodb";
import type { AssetKind } from "../storage/cas";

export interface AtelierAsset {
  sha256: string;
  size: number;
  kind: AssetKind;
  diskPath: string;
  refCount: number;
  firstUploadedByDiscordId: string;
  firstUploadedAt: Date;
  lastReferencedAt: Date | null;
}

export async function assetsCol() {
  return col<AtelierAsset>("atelierAssets");
}
