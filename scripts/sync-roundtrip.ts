/**
 * Scripted cloud-sync round-trip against a RUNNING atelier-api with dev fake
 * auth — proves the exact PUSH/PULL pipeline the desktop app uses
 * (atelier/src/lib/sync/pack-sync.ts) without the UI:
 *
 *   PUSH: POST /assets/check -> upload missing via the chunk protocol
 *         (init -> PUT chunks at the server-fixed chunkSize -> complete)
 *         -> POST revision 1 with the contract drawable mapping
 *   PULL: GET head manifest -> GET /assets/:sha256 -> byte-compare
 *
 *   Terminal 1: bun run dev
 *   Terminal 2: bun run sync-roundtrip
 *
 * Fixtures (pack + the two deterministic test assets) self-clean at start
 * and end, so repeated/crashed runs cannot poison each other.
 */

import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnv, type Env } from "../src/env";
import { configureMongo, getDb, closeMongo } from "../src/mongodb";

const BASE = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3095";
const REDIRECT_URI = "http://127.0.0.1:53682/callback";
const PACK_NAME = "Sync Roundtrip Pack";

/** Deterministic pseudo-random payload (xorshift32) — same sha256 every run. */
function buildAsset(size: number, seed: number): Buffer {
  const buf = Buffer.alloc(size);
  let x = seed >>> 0;
  for (let i = 0; i + 3 < size; i += 4) {
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    buf.writeUInt32LE(x, i);
  }
  return buf;
}

const YDD_ASSET = buildAsset(48 * 1024, 0x4fee1901);
const YTD_ASSET = buildAsset(20 * 1024, 0x4fee1902);
const YDD_SHA = createHash("sha256").update(YDD_ASSET).digest("hex");
const YTD_SHA = createHash("sha256").update(YTD_ASSET).digest("hex");

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : "");
  }
}

/** Remove pack + asset fixtures of this script (start AND end). */
async function cleanupFixtures(env: Env): Promise<void> {
  try {
    const db = await getDb();
    const shas = [YDD_SHA, YTD_SHA];

    const uploads = await db
      .collection("atelierUploads")
      .find({ sha256Expected: { $in: shas } })
      .toArray();
    for (const u of uploads) {
      if (typeof u.tmpPath === "string") await rm(u.tmpPath, { force: true }).catch(() => {});
    }
    await db.collection("atelierUploads").deleteMany({ sha256Expected: { $in: shas } });
    const assets = await db.collection("atelierAssets").find({ sha256: { $in: shas } }).toArray();
    await db.collection("atelierAssets").deleteMany({ sha256: { $in: shas } });
    for (const a of assets) {
      const kind = typeof a.kind === "string" ? a.kind : "ydd";
      const sha = a.sha256 as string;
      await rm(resolve(env.ATELIER_STORAGE_ROOT, "cas", sha.slice(0, 2), `${sha}.${kind}`), {
        force: true,
      }).catch(() => {});
    }

    const packs = await db.collection("atelierPacks").find({ name: PACK_NAME }).toArray();
    const packIds = packs.map((p) => p.packId as string);
    if (packIds.length > 0) {
      await db.collection("atelierRevisions").deleteMany({ packId: { $in: packIds } });
      await db.collection("atelierLocks").deleteMany({ packId: { $in: packIds } });
      await db.collection("atelierActivity").deleteMany({ "data.packId": { $in: packIds } });
      await db.collection("atelierPacks").deleteMany({ packId: { $in: packIds } });
    }
  } catch (e) {
    console.warn("  WARN  fixture cleanup skipped:", (e as Error).message);
  }
}

async function getCodeViaFakeLogin(): Promise<string> {
  const url = new URL(`${BASE}/api/v1/auth/discord/start`);
  url.searchParams.set("redirect_uri", REDIRECT_URI);
  const res = await fetch(url, { redirect: "manual" });
  const location = res.headers.get("location") ?? "";
  if (res.status !== 302 || !location.startsWith(REDIRECT_URI)) {
    throw new Error(`fake login failed: status=${res.status} location=${location}`);
  }
  const code = new URL(location).searchParams.get("code") ?? "";
  if (!/^[0-9a-f]{32}$/u.test(code)) throw new Error(`unexpected code format: ${code}`);
  return code;
}

async function api(path: string, token: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${token}`,
      ...(init?.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}),
    },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {}
  return { status: res.status, body };
}

/**
 * Mirrors uploadLocalAsset() in the app: init -> PUT every chunk at the
 * server-fixed chunkSize -> complete. Tolerates 409 already_exists.
 */
async function uploadViaChunkProtocol(
  token: string,
  bytes: Buffer,
  sha256: string,
  kind: "ydd" | "ytd",
): Promise<void> {
  const init = await api("/api/v1/uploads", token, {
    method: "POST",
    body: JSON.stringify({ sha256, kind, size: bytes.byteLength }),
  });
  if (init.status === 409 && init.body?.error === "already_exists") return;
  check(`upload init (${kind}) 200 + server-fixed chunkSize`, init.status === 200 && init.body.chunkSize > 0, init.body);

  const { uploadId, chunkSize, totalChunks, receivedChunks } = init.body as {
    uploadId: string;
    chunkSize: number;
    totalChunks: number;
    receivedChunks: number[];
  };
  const received = new Set(receivedChunks);
  for (let index = 0; index < totalChunks; index++) {
    if (received.has(index)) continue;
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, bytes.byteLength);
    const res = await fetch(`${BASE}/api/v1/uploads/${uploadId}/chunks/${index}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      // copy into a plain Uint8Array<ArrayBuffer> — Buffer is not a BodyInit for TS
      body: new Uint8Array(bytes.subarray(start, end)),
    });
    if (res.status !== 200) {
      check(`PUT chunk ${index} (${kind}) 200`, false, await res.text());
      return;
    }
  }
  const complete = await api(`/api/v1/uploads/${uploadId}/complete`, token, { method: "POST" });
  check(`upload complete (${kind}) ok + sha echo`, complete.status === 200 && complete.body?.sha256 === sha256, complete.body);
}

async function main() {
  console.log(`atelier-api sync round-trip against ${BASE}\n`);

  const env = loadEnv();
  configureMongo(env);
  await cleanupFixtures(env);

  // ------------------------------------------------------------- fake login
  console.log("[1] login (dev fake auth)");
  const code = await getCodeViaFakeLogin();
  const exchange = await fetch(`${BASE}/api/v1/auth/device/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      redirect_uri: REDIRECT_URI,
      device: { name: "Sync Roundtrip", platform: "windows", appVersion: "0.1.0-roundtrip" },
    }),
  });
  const tokens = (await exchange.json()) as { accessToken: string };
  check("exchange 200", exchange.status === 200);
  const token = tokens.accessToken;

  // ------------------------------------------------------------ create pack
  console.log("[2] create pack");
  const packRes = await api("/api/v1/packs", token, {
    method: "POST",
    body: JSON.stringify({ name: PACK_NAME, description: "scripted push/pull round-trip" }),
  });
  check("pack created, headRevision 0", packRes.status === 200 && packRes.body?.pack?.headRevision === 0, packRes.body);
  const packId = packRes.body.pack.packId as string;

  // -------------------------------------------- PUSH phase 1: assets/check
  console.log("[3] push: assets/check");
  const check1 = await api("/api/v1/assets/check", token, {
    method: "POST",
    body: JSON.stringify({ files: [{ sha256: YDD_SHA }, { sha256: YTD_SHA }] }),
  });
  check(
    "both assets reported missing",
    check1.status === 200 &&
      check1.body?.missing?.length === 2 &&
      check1.body.missing.includes(YDD_SHA) &&
      check1.body.missing.includes(YTD_SHA),
    check1.body,
  );

  // ------------------------------------- PUSH phase 2: chunk-protocol upload
  console.log("[4] push: upload via chunk protocol");
  await uploadViaChunkProtocol(token, YDD_ASSET, YDD_SHA, "ydd");
  await uploadViaChunkProtocol(token, YTD_ASSET, YTD_SHA, "ytd");

  const check2 = await api("/api/v1/assets/check", token, {
    method: "POST",
    body: JSON.stringify({ files: [{ sha256: YDD_SHA }, { sha256: YTD_SHA }] }),
  });
  check(
    "both assets now present",
    check2.status === 200 && check2.body?.present?.length === 2 && check2.body?.missing?.length === 0,
    check2.body,
  );

  // --------------------------------------- PUSH phase 3: commit revision 1
  console.log("[5] push: POST revision 1");
  // Exactly the app's toRevisionDrawable() mapping (revision-mapping.ts).
  const drawable = {
    id: randomUUID(),
    gender: "male",
    kind: "component",
    type: "jbib",
    mode: "addon",
    replaceTargetId: null,
    label: "Roundtrip Jacke",
    groupId: null,
    ydd: { sha256: YDD_SHA, size: YDD_ASSET.byteLength, exportName: "jbib_000_u.ydd" },
    textures: [{ sha256: YTD_SHA, size: YTD_ASSET.byteLength, exportName: "jbib_diff_000_a_uni.ytd" }],
    physics: null,
    firstPerson: null,
    flags: { highHeels: false, hairScaleValue: null },
  };
  const revRes = await api(`/api/v1/packs/${packId}/revisions`, token, {
    method: "POST",
    body: JSON.stringify({ baseRevision: 0, message: "roundtrip push", drawables: [drawable] }),
  });
  check("revision 1 committed", revRes.status === 200 && revRes.body?.revision?.revision === 1, revRes.body);

  // ------------------------------------------- PULL phase 1: head manifest
  console.log("[6] pull: head manifest");
  const manifest = await api(`/api/v1/packs/${packId}/revisions/head/manifest`, token);
  const remote = manifest.body?.revision?.drawables?.[0];
  check("manifest is revision 1 with the drawable", manifest.status === 200 && manifest.body?.revision?.revision === 1 && manifest.body.revision.drawables.length === 1, manifest.body);
  check(
    "drawable mapping survived (id/type/refs/flags)",
    remote?.id === drawable.id &&
      remote?.type === "jbib" &&
      remote?.ydd?.sha256 === YDD_SHA &&
      remote?.ydd?.exportName === "jbib_000_u.ydd" &&
      remote?.textures?.[0]?.sha256 === YTD_SHA &&
      remote?.flags?.hairScaleValue === null,
    remote,
  );

  // --------------------------------- PULL phase 2: download + byte-compare
  console.log("[7] pull: download assets + byte-compare");
  for (const [label, sha, source] of [
    ["ydd", YDD_SHA, YDD_ASSET],
    ["ytd", YTD_SHA, YTD_ASSET],
  ] as const) {
    const res = await fetch(`${BASE}/api/v1/assets/${sha}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const bytes = Buffer.from(await res.arrayBuffer());
    check(
      `${label} download 200 + bytes identical`,
      res.status === 200 && bytes.length === source.length && bytes.equals(source),
      { status: res.status, length: bytes.length },
    );
    check(
      `${label} download hash matches sha256`,
      createHash("sha256").update(bytes).digest("hex") === sha,
    );
  }

  // ----------------------------------------------------------------- done
  await cleanupFixtures(env);
  await closeMongo();
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("sync round-trip crashed:", e);
  process.exit(1);
});
