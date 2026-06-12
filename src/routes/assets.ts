/**
 * CAS asset endpoints:
 *   POST /api/v1/assets/check    which of these hashes do we already have?
 *   GET  /api/v1/assets/:sha256  immutable download (ETag + single-range)
 */

import type { Router } from "../router";
import type { Env } from "../env";
import { json, err, readJsonBody } from "../http";
import { requireUser } from "../auth/require";
import { casExists, casPathFor, isSha256Hex } from "../storage/cas";
import { assetsCol } from "../models/atelierAsset";

const MAX_CHECK_FILES = 500;

type ParsedRange = { start: number; end: number } | "unsatisfiable" | null;

/** Parse a single-range "bytes=..." header; null = ignore (serve full body). */
function parseRange(header: string | null, size: number): ParsedRange {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!m) return null; // multi-range/malformed -> a server MAY ignore Range
  const [, rawStart, rawEnd] = m;
  if (rawStart === "" && rawEnd === "") return null;

  if (rawStart === "") {
    // suffix range: last N bytes
    const suffix = Number(rawEnd);
    if (suffix === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (start >= size) return "unsatisfiable";
  const end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start > end) return "unsatisfiable";
  return { start, end };
}

export function registerAssetRoutes(router: Router, env: Env): void {
  // --------------------------------------------------- POST /assets/check
  router.post("/api/v1/assets/check", async ({ req }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;

    const body = await readJsonBody(req);
    if (!body || !Array.isArray(body.files)) return err("files_must_be_array", 400);
    if (body.files.length > MAX_CHECK_FILES) return err("too_many_files", 400);

    const shas = new Set<string>();
    for (const file of body.files) {
      const o = (typeof file === "object" && file !== null ? file : {}) as Record<string, unknown>;
      const sha256 = typeof o.sha256 === "string" ? o.sha256.toLowerCase() : "";
      if (!isSha256Hex(sha256)) return err("invalid_sha256", 400);
      shas.add(sha256);
    }

    const assets = await assetsCol();
    const found = await assets
      .find({ sha256: { $in: [...shas] } }, { projection: { sha256: 1, kind: 1 } })
      .toArray();
    // A hash only counts as "present" when its file is ALSO on disk. A wiped
    // CAS volume can leave the Mongo doc behind; reporting "present" then would
    // make clients skip re-uploading a file the server no longer has, so the
    // pull/clone of that revision would 404 with asset_not_found forever.
    const present = new Set<string>();
    for (const a of found) {
      if (await casExists(a.sha256, a.kind)) present.add(a.sha256);
    }

    return json({
      missing: [...shas].filter((s) => !present.has(s)),
      present: [...present],
    });
  });

  // --------------------------------------------------- GET /assets/:sha256
  router.get("/api/v1/assets/:sha256", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;

    const sha256 = params.sha256!.toLowerCase();
    if (!isSha256Hex(sha256)) return err("invalid_sha256", 400);

    const assets = await assetsCol();
    const asset = await assets.findOne({ sha256 });
    if (!asset || !(await casExists(sha256, asset.kind))) return err("asset_not_found", 404);

    const etag = `"${sha256}"`;
    const baseHeaders: Record<string, string> = {
      etag,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=31536000, immutable",
    };

    const ifNoneMatch = req.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatch.split(",").some((v) => v.trim().replace(/^W\//u, "") === etag)) {
      return new Response(null, { status: 304, headers: baseHeaders });
    }

    const range = parseRange(req.headers.get("range"), asset.size);
    if (range === "unsatisfiable") {
      return json({ error: "range_not_satisfiable" }, 416, {
        ...baseHeaders,
        "content-range": `bytes */${asset.size}`,
      });
    }

    const file = Bun.file(casPathFor(sha256, asset.kind));
    if (range) {
      return new Response(file.slice(range.start, range.end + 1), {
        status: 206,
        headers: {
          ...baseHeaders,
          "content-type": "application/octet-stream",
          "content-length": String(range.end - range.start + 1),
          "content-range": `bytes ${range.start}-${range.end}/${asset.size}`,
        },
      });
    }
    return new Response(file, {
      status: 200,
      headers: {
        ...baseHeaders,
        "content-type": "application/octet-stream",
        "content-length": String(asset.size),
      },
    });
  });
}
