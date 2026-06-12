/**
 * Resumable chunked uploads into the CAS:
 *   POST /api/v1/uploads                          init (or resume) a session
 *   PUT  /api/v1/uploads/:uploadId/chunks/:index  raw chunk (octet-stream)
 *   GET  /api/v1/uploads/:uploadId                session status
 *   POST /api/v1/uploads/:uploadId/complete       verify hash -> move into CAS
 *
 * Chunk size is SERVER-fixed (ATELIER_MAX_CHUNK_BYTES); clients must use the
 * value from the init response. Chunks may arrive in any order, each is
 * written at offset index*chunkSize; only the last chunk may be short.
 * One open session per (sha256, user) — repeating the init returns it
 * (that is the resume path). Sessions expire after 48h (Mongo TTL).
 */

import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import type { Router } from "../router";
import type { Env } from "../env";
import { json, err, readJsonBody } from "../http";
import { requireUser } from "../auth/require";
import {
  casExists,
  deleteTmp,
  finalizeFromTmp,
  isAssetKind,
  isSha256Hex,
  tmpPathFor,
} from "../storage/cas";
import { assetsCol } from "../models/atelierAsset";
import { uploadsCol, UPLOAD_TTL_MS, type AtelierUpload } from "../models/atelierUpload";
import { logActivity } from "../models/activity";

function sortedChunks(chunks: number[]): number[] {
  return [...chunks].sort((a, b) => a - b);
}

export function registerUploadRoutes(router: Router, env: Env): void {
  // -------------------------------------------------------- POST /uploads
  router.post("/api/v1/uploads", async ({ req }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;

    const body = await readJsonBody(req);
    if (!body) return err("invalid_json", 400);

    const sha256 = typeof body.sha256 === "string" ? body.sha256.toLowerCase() : "";
    if (!isSha256Hex(sha256)) return err("invalid_sha256", 400);
    if (!isAssetKind(body.kind)) return err("invalid_kind", 400);
    const size = body.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1) return err("invalid_size", 400);
    if (size > env.ATELIER_MAX_ASSET_BYTES) return err("asset_too_large", 413);

    // Only short-circuit when the file is ACTUALLY on disk. If the CAS volume
    // was wiped but the Mongo doc survived, allow a fresh upload to restore the
    // file (the complete handler's asset upsert is idempotent).
    const assets = await assetsCol();
    const existingAsset = await assets.findOne({ sha256 });
    if (existingAsset && (await casExists(sha256, existingAsset.kind))) {
      return err("already_exists", 409);
    }

    // Resume: an open session of the same user for the same content.
    const uploads = await uploadsCol();
    const existing = await uploads.findOne({
      sha256Expected: sha256,
      createdByDiscordId: auth.user.discordId,
      status: "open",
      expiresAt: { $gt: new Date() },
    });
    if (existing) {
      if (existing.size !== size || existing.kind !== body.kind) return err("upload_conflict", 409);
      return json({
        uploadId: existing.uploadId,
        chunkSize: existing.chunkSize,
        totalChunks: existing.totalChunks,
        receivedChunks: sortedChunks(existing.receivedChunks),
      });
    }

    const chunkSize = env.ATELIER_MAX_CHUNK_BYTES;
    const totalChunks = Math.ceil(size / chunkSize);
    const uploadId = randomUUID();
    const tmpPath = tmpPathFor(uploadId);

    // Pre-create the tmp file so out-of-order chunk writes can open it r+.
    await (await open(tmpPath, "w")).close();

    const now = new Date();
    const session: AtelierUpload = {
      uploadId,
      sha256Expected: sha256,
      size,
      kind: body.kind,
      chunkSize,
      totalChunks,
      receivedChunks: [],
      tmpPath,
      createdByDiscordId: auth.user.discordId,
      deviceId: auth.device.deviceId,
      status: "open",
      createdAt: now,
      expiresAt: new Date(now.getTime() + UPLOAD_TTL_MS),
    };
    await uploads.insertOne({ ...session });

    return json({ uploadId, chunkSize, totalChunks, receivedChunks: [] });
  });

  // ------------------------------------- PUT /uploads/:uploadId/chunks/:index
  router.put("/api/v1/uploads/:uploadId/chunks/:index", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;

    const uploads = await uploadsCol();
    const session = await uploads.findOne({
      uploadId: params.uploadId!,
      createdByDiscordId: auth.user.discordId, // foreign sessions look like 404 on purpose
      status: "open",
      expiresAt: { $gt: new Date() },
    });
    if (!session) return err("upload_not_found", 404);

    const index = Number(params.index);
    if (!/^\d+$/u.test(params.index!) || !Number.isInteger(index) || index >= session.totalChunks) {
      return err("invalid_chunk_index", 400);
    }

    const isLast = index === session.totalChunks - 1;
    const expectedLen = isLast
      ? session.size - (session.totalChunks - 1) * session.chunkSize
      : session.chunkSize;
    const bytes = new Uint8Array(await req.arrayBuffer());
    if (bytes.byteLength !== expectedLen) return err("invalid_chunk_size", 409);

    // Write at the chunk's offset; recreate the tmp file if it vanished
    // (e.g. external cleanup) — /complete hash-verifies everything anyway.
    const fh = await open(session.tmpPath, "r+").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return open(session.tmpPath, "w+");
      throw e;
    });
    try {
      await fh.write(bytes, 0, bytes.byteLength, index * session.chunkSize);
    } finally {
      await fh.close();
    }

    const updated = await uploads.findOneAndUpdate(
      { uploadId: session.uploadId },
      { $addToSet: { receivedChunks: index } },
      { returnDocument: "after" },
    );
    return json({ receivedChunks: sortedChunks(updated?.receivedChunks ?? [index]) });
  });

  // --------------------------------------------------- GET /uploads/:uploadId
  router.get("/api/v1/uploads/:uploadId", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;

    const uploads = await uploadsCol();
    const session = await uploads.findOne({
      uploadId: params.uploadId!,
      createdByDiscordId: auth.user.discordId,
      expiresAt: { $gt: new Date() },
    });
    if (!session) return err("upload_not_found", 404);

    return json({
      uploadId: session.uploadId,
      sha256: session.sha256Expected,
      size: session.size,
      chunkSize: session.chunkSize,
      totalChunks: session.totalChunks,
      receivedChunks: sortedChunks(session.receivedChunks),
      status: session.status,
    });
  });

  // ------------------------------------------ POST /uploads/:uploadId/complete
  router.post("/api/v1/uploads/:uploadId/complete", async ({ req, params }) => {
    const auth = await requireUser(req, env);
    if (auth instanceof Response) return auth;

    // Claim the session (open -> finalizing) so concurrent completes can't race.
    const uploads = await uploadsCol();
    const session = await uploads.findOneAndUpdate(
      {
        uploadId: params.uploadId!,
        createdByDiscordId: auth.user.discordId,
        status: "open",
        expiresAt: { $gt: new Date() },
      },
      { $set: { status: "finalizing" } },
      { returnDocument: "after" },
    );
    if (!session) return err("upload_not_found", 404);

    const releaseToOpen = () =>
      uploads.updateOne({ uploadId: session.uploadId }, { $set: { status: "open" } }).catch(() => {});

    if (session.receivedChunks.length !== session.totalChunks) {
      await releaseToOpen();
      return err("missing_chunks", 409);
    }

    let result: Awaited<ReturnType<typeof finalizeFromTmp>>;
    try {
      result = await finalizeFromTmp(session.tmpPath, session.sha256Expected, session.kind);
    } catch (e) {
      await releaseToOpen();
      throw e;
    }
    if (!result.ok) {
      // Corrupt upload — drop session + tmp, the client must start over.
      await deleteTmp(session.tmpPath).catch(() => {});
      await uploads.deleteOne({ uploadId: session.uploadId });
      return err("hash_mismatch", 422);
    }

    const assets = await assetsCol();
    const now = new Date();
    await assets.updateOne(
      { sha256: session.sha256Expected },
      {
        $setOnInsert: {
          sha256: session.sha256Expected,
          size: session.size,
          kind: session.kind,
          diskPath: result.diskPath,
          refCount: 0,
          firstUploadedByDiscordId: auth.user.discordId,
          firstUploadedAt: now,
          lastReferencedAt: null,
        },
      },
      { upsert: true },
    );
    await uploads.deleteOne({ uploadId: session.uploadId });
    void logActivity("asset.uploaded", auth.user.discordId, {
      sha256: session.sha256Expected,
      size: session.size,
      kind: session.kind,
    });

    return json({ ok: true, sha256: session.sha256Expected });
  });
}
