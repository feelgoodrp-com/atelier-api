/**
 * On-demand disk-usage stats for the admin dashboard. Walks the two-level
 * layout under ATELIER_STORAGE_ROOT (cas/<2hex>/<file>, builds/<packId>/<rev>.zip,
 * tmp/<file>) and sums sizes. Best-effort: unreadable entries are skipped.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { storageRoot } from "./cas";

export interface DirUsage {
  files: number;
  bytes: number;
}

export interface StorageStats {
  root: string;
  totalBytes: number;
  cas: DirUsage;
  builds: DirUsage;
  tmp: DirUsage;
}

/** Sum file sizes one or two levels deep under `dir` (matches the CAS layout). */
async function dirUsage(dir: string): Promise<DirUsage> {
  let files = 0;
  let bytes = 0;
  let level1: string[];
  try {
    level1 = await readdir(dir);
  } catch {
    return { files, bytes };
  }
  for (const a of level1) {
    const p1 = join(dir, a);
    let s1;
    try {
      s1 = await stat(p1);
    } catch {
      continue;
    }
    if (s1.isFile()) {
      files++;
      bytes += s1.size;
      continue;
    }
    if (!s1.isDirectory()) continue;
    let level2: string[];
    try {
      level2 = await readdir(p1);
    } catch {
      continue;
    }
    for (const b of level2) {
      try {
        const s2 = await stat(join(p1, b));
        if (s2.isFile()) {
          files++;
          bytes += s2.size;
        }
      } catch {
        // skip unreadable entry
      }
    }
  }
  return { files, bytes };
}

export async function computeStorageStats(): Promise<StorageStats> {
  const root = storageRoot();
  const [cas, builds, tmp] = await Promise.all([
    dirUsage(join(root, "cas")),
    dirUsage(join(root, "builds")),
    dirUsage(join(root, "tmp")),
  ]);
  return {
    root,
    totalBytes: cas.bytes + builds.bytes + tmp.bytes,
    cas,
    builds,
    tmp,
  };
}
