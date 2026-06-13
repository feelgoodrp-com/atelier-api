# atelier-api

Backend-Service für **atelier by feelgood** — das GTA-V-Addon-Clothing-Tool
(Tauri-Desktop-App + kollaboratives Backend). Discord-Login, Device-Tokens,
User-Freischaltung, Admin-Verwaltung, CAS-Uploads, Packs/Revisionen, Locks,
WebSocket-Collab sowie Server-Builds, Publish/Registry und Creative-Import.

- **Runtime:** Bun (`Bun.serve`, kein Framework)
- **Datenbank:** MongoDB (raw driver, kein ORM), DB `feelgoodrp`
- **Port:** `3095`
- **Fehler-Konvention:** `{ "error": "message" }`

> ⚠️ **Server-Build-Limitierung (YMT):** Die echten binären
> `CPedVariationInfo`-YMTs (`mp_m_freemode_01_<dlc>.ymt`,
> `mp_creaturemetadata_*.ymt`) kann nur der **Desktop-Build** der atelier-App
> erzeugen (CodeWalker/.NET). Server-Builds enthalten alles **außer** den
> YMTs plus `stream/ATELIER_README.txt` mit Hinweis; `atelier-build.json`
> trägt `"ymt": "missing-server-build"`. Registry-Downloads taugen damit für
> Vorschau/Verteilung — vollständige In-Game-Packs kommen aus Desktop-Builds.
> Ein künftiges ymt-service-Sidecar-Deployment kann die Lücke schließen.

## Architektur

```
atelier-api/
├── src/
│   ├── index.ts            Bun.serve + Routen-Registrierung + CORS
│   ├── env.ts              Typisierte Env-Validierung (fail fast)
│   ├── router.ts           Mini-Router (Methode + Pfad + :params, 0 Deps)
│   ├── mongodb.ts          Lazy-Singleton-Client + ensureIndexes()
│   ├── http.ts             json/err/redirect/Cookie/Loopback-Helpers
│   ├── auth/
│   │   ├── jwt.ts          HS256-JWT sign/verify (node:crypto, 0 Deps)
│   │   ├── device-auth.ts  atelierDevices + Refresh-Token-Rotation
│   │   └── require.ts      requireUser / requireAdmin / requireService
│   ├── models/
│   │   ├── atelierUser.ts  atelierUsers (pending/approved/locked)
│   │   ├── authCode.ts     atelierAuthCodes (One-Time-Codes, TTL 60s)
│   │   ├── atelierAsset.ts atelierAssets (CAS-Metadaten)
│   │   ├── atelierUpload.ts atelierUploads (Resumable-Sessions)
│   │   ├── atelierPack.ts  atelierPacks (+ publish-Status)
│   │   ├── atelierRevision.ts atelierRevisions (immutable Snapshots)
│   │   ├── atelierLock.ts  atelierLocks (Advisory-Locks)
│   │   ├── atelierBuild.ts atelierBuilds (Server-Build-Cache)
│   │   └── activity.ts     atelierActivity (Audit-Log)
│   ├── storage/cas.ts      Content-addressed Storage (+ casImportFile)
│   ├── cloth/fivem-export.ts  FiveM-Resource-Builder (ohne YMTs, s. u.)
│   ├── builds/queue.ts     In-Process-Build-Queue (Concurrency, Artifacts)
│   ├── ws/collab.ts        WebSocket-Räume (Presence, Locks, build-status)
│   └── routes/
│       ├── auth.ts         Discord OAuth start/callback (+ Dev-Fake-Mode)
│       ├── devices.ts      exchange/refresh/logout + Geräteverwaltung
│       ├── me.ts           GET /api/v1/me
│       ├── admin.ts        Userliste, approve/lock/role
│       ├── uploads.ts      Chunk-Uploads in den CAS
│       ├── assets.ts       Asset-Check + Download (ETag/Range)
│       ├── packs.ts        Packs/Revisionen/Members + publish
│       ├── presence.ts     Presence-REST
│       ├── locks.ts        Drawable-Locks
│       ├── builds.ts       Server-Builds (Status + Artifact-ZIP)
│       ├── registry.ts     Registry für Community-Websites (Service-Lane)
│       └── import-creative.ts  Einmal-Import aus creative
└── scripts/
    ├── smoke.ts            E2E-Smoke-Test gegen laufenden Server
    └── sync-roundtrip.ts   Push/Pull-Roundtrip (Pack, Chunk-Upload, Revision, Download)
```

### Mongo-Collections

| Collection         | Inhalt                                                            | Indexe |
| ------------------ | ----------------------------------------------------------------- | ------ |
| `atelierUsers`     | discordId, username, avatar, status, role, createdAt, approvedBy… | `discordId` unique |
| `atelierAuthCodes` | One-Time-Codes (Browser → App), TTL 60 s, single-use              | `expiresAt` TTL, `code` unique |
| `atelierDevices`   | deviceId, refreshTokenHash (sha256), tokenVersion, revokedAt …    | `deviceId` unique, `discordId`, `refreshTokenHash` |
| `atelierActivity`  | Audit-Log `{ type, actorDiscordId, ts, data }`                    | `ts` |
| `atelierAssets`    | CAS-Assets `{ sha256, size, kind, diskPath, refCount }`           | `sha256` unique |
| `atelierUploads`   | Resumable-Upload-Sessions (Chunks, TTL 48 h)                      | `uploadId` unique, TTL |
| `atelierPacks`     | Packs inkl. `publish { visibility, targets, publishedRevision }`  | `packId` unique, `slug` (aktiv) unique |
| `atelierRevisions` | Unveränderliche Snapshots der Drawables                           | `{ packId, revision }` unique |
| `atelierLocks`     | Advisory-Locks pro Drawable (TTL)                                 | `{ packId, drawableEntryId }` unique, TTL |
| `atelierBuilds`    | Server-Builds (Cache pro Revision, Artifact-Pfad, Report)         | `buildId` unique, `{ packId, revision }` unique |

## Auth-Flow

```
Desktop-App                 atelier-api                      Discord
    |                            |                              |
    | GET /auth/discord/start?redirect_uri=http://127.0.0.1:<port>/cb
    |--------------------------->|                              |
    |                            |-- 302 (state signiert, ----->|
    |                            |    Nonce-Cookie)             |
    |                            |                              |
    |                            |<-- 302 /auth/discord/callback|
    |                            |    ?code&state               |
    |                            |-- code -> token, /users/@me  |
    |                            |   upsert atelierUsers        |
    |                            |   (neu => status pending)    |
    |<-- 302 {redirect_uri}?code=<one-time, 60s TTL> -----------|
    |                            |
    | POST /auth/device/exchange { code, redirect_uri, device }
    |--------------------------->|  Code single-use entwerten,
    |                            |  Device anlegen
    |<-- { accessToken (JWT 1h), refreshToken (90d, rotierend), user }
    |                            |
    | ... accessToken abgelaufen ...
    | POST /auth/device/refresh { refreshToken }
    |--------------------------->|  Hash prüfen, User neu lesen,
    |                            |  ROTATION: alter Token sofort ungültig
    |<-- { accessToken, refreshToken (NEU), user }
```

- **Access-Token:** JWT HS256, 1 h, Claims `discordId/username/avatar/deviceId/tokenVersion/role/status`.
- **Refresh-Token:** 48 Random-Bytes hex, nur als sha256-Hash gespeichert, 90 Tage, bei jedem Refresh rotiert.
- **tokenVersion:** wird bei Revoke/Logout/Lock erhöht → alle ausgestellten JWTs des Geräts sofort ungültig.
- **Pending-Gate:** Jeder `/api/v1/*`-Endpoint außer `/api/v1/me` und den Auth-/Device-Routen liefert für
  nicht freigeschaltete User `403 { "error": "pending_approval" }` (gesperrt: `403 { "error": "locked" }`).
- **Admin-Override:** Discord-IDs aus `ATELIER_ADMIN_DISCORD_IDS` werden bei jedem Login/Refresh/Request
  auf `status=approved` + `role=admin` gezwungen.

### Dev-Fake-Mode (ohne Discord-App)

Wenn `ATELIER_DEV_FAKE_AUTH=1` **und** die Discord-Credentials auf `CHANGEME`/leer
stehen (und `NODE_ENV != production`), überspringt `/auth/discord/start` Discord
komplett: Der Fake-User (`ATELIER_DEV_FAKE_DISCORD_ID`, Username `DevUser`) wird
direkt angelegt und mit One-Time-Code zurück zur App umgeleitet. Nur im Fake-Mode
sind die Query-Overrides `&dev_id=<discordId>` und `&dev_username=` erlaubt
(für Multi-User-Tests, siehe `scripts/smoke.ts`).

## Umgebungsvariablen

Bun lädt `.env` und `.env.local` automatisch. Vorlage: `.env.example`.

| Variable | Pflicht | Default | Beschreibung |
| --- | --- | --- | --- |
| `PORT` | nein | `3095` | HTTP-Port |
| `HOST` | nein | `127.0.0.1` | Bind-Adresse (Deployment: `0.0.0.0`) |
| `MONGODB_URI` | **ja** | – | MongoDB-Connection-String (Atlas/lokal) |
| `MONGODB_DB_NAME` | nein | `feelgoodrp` | Datenbankname |
| `MONGODB_DNS_SERVERS` | nein | – | DNS-Override (z. B. `8.8.8.8`) bei `querySrv ECONNREFUSED` unter Bun/Windows |
| `ATELIER_PUBLIC_ORIGIN` | nein | `http://127.0.0.1:3095` | Öffentliche Basis-URL (Discord-Redirect) |
| `ATELIER_DISCORD_CLIENT_ID` | nein* | `CHANGEME` | Discord-App Client-ID |
| `ATELIER_DISCORD_CLIENT_SECRET` | nein* | `CHANGEME` | Discord-App Client-Secret |
| `ATELIER_ADMIN_DISCORD_IDS` | nein | leer | Kommaseparierte IDs, immer approved+admin |
| `ATELIER_JWT_SECRET` | **ja** | – | HS256-Secret (min. 32 Zeichen) |
| `ATELIER_SERVICE_TOKEN` | **ja** | – | Header `x-fg-service-token` für Service-zu-Service |
| `ATELIER_STORAGE_ROOT` | nein | `./data` | Datei-Storage (`cas/`, `tmp/`, `builds/`) |
| `ATELIER_BUILD_CONCURRENCY` | nein | `2` | Parallel laufende Server-Builds |
| `ATELIER_CREATIVE_CLOTH_ROOT` | nein | leer | creative-`CLOTH_UPLOAD_ROOT` für den Creative-Import (leer = Endpoint 503) |
| `ATELIER_DEV_FAKE_AUTH` | nein | `0` | `1` = Fake-Login (nur Dev, s. o.) |
| `ATELIER_DEV_FAKE_DISCORD_ID` | nein | – | Discord-ID des Fake-Users |

\* Pflicht für echten Discord-Login; im Fake-Mode nicht nötig.

## Endpoints

| Methode | Pfad | Auth | Beschreibung |
| --- | --- | --- | --- |
| GET | `/health` | – | `{ ok, service, version }` |
| GET | `/api/v1/auth/discord/start?redirect_uri=` | – | 302 zu Discord (oder Fake-Login) |
| GET | `/api/v1/auth/discord/callback` | – | OAuth-Callback, 302 zur App mit `?code=` |
| POST | `/api/v1/auth/device/exchange` | – | `{ code, redirect_uri, device }` → Tokens |
| POST | `/api/v1/auth/device/refresh` | – | `{ refreshToken }` → neue Tokens (Rotation) |
| POST | `/api/v1/auth/device/logout` | Bearer | Eigenes Gerät abmelden |
| GET | `/api/v1/me` | Bearer (auch pending) | `{ user, device }` |
| GET | `/api/v1/devices` | Bearer (approved) | Eigene Geräte |
| DELETE | `/api/v1/devices/:deviceId` | Bearer (approved) | Eigenes Gerät widerrufen |
| GET | `/api/v1/admin/users?status=` | Admin | Userliste |
| POST | `/api/v1/admin/users/:discordId/approve` | Admin | Freischalten |
| POST | `/api/v1/admin/users/:discordId/lock` | Admin | Sperren + alle Geräte widerrufen |
| POST | `/api/v1/admin/users/:discordId/role` | Admin | `{ role: "admin"\|"member" }` |
| GET | `/api/v1/internal/ping` | `x-fg-service-token` | Service-zu-Service-Probe |
| POST | `/api/v1/packs/:packId/builds` | Editor+ | `{ revision: n\|"head" }` → 202 (Build läuft) bzw. 200 (Cache) |
| GET | `/api/v1/builds/:buildId` | Member+ | Build-Status `{ queued\|running\|done\|error }` |
| GET | `/api/v1/builds/:buildId/artifact` | Member+ | Artifact-ZIP (FiveM-Resource, ohne YMTs, s. o.) |
| POST | `/api/v1/packs/:packId/publish` | Owner | `{ visibility, targets, revision }` → Registry-Listing |
| GET | `/api/v1/registry/packs?target=&q=&page=&pageSize=` | `x-fg-service-token` | Veröffentlichte Packs (community) |
| GET | `/api/v1/registry/packs/:idOrSlug` | `x-fg-service-token` | Pack + veröffentlichtes Revisions-Manifest |
| GET | `/api/v1/registry/packs/:idOrSlug/download` | `x-fg-service-token` | Build-ZIP (202 `{ build }` solange gebaut wird) |
| POST | `/api/v1/import/creative/:creativeProjectId` | Admin | Einmal-Import eines creative-Cloth-Packs → Pack + Revision 1 |

### Server-Builds & Registry

- Builds sind **pro `{ packId, revision }` gecached** (Revisionen sind
  unveränderlich): erster `POST /builds` → `202` + Queue
  (`ATELIER_BUILD_CONCURRENCY`), fertige Builds → `200` mit Cache-Treffer.
  Artifacts: `<ATELIER_STORAGE_ROOT>/builds/<packId>/<revision>.zip`.
- Status-Übergänge werden als `{ type: "build-status", buildId, status }`
  in den Pack-WebSocket-Raum gebroadcastet; Abschlüsse landen als
  `build.completed` im Activity-Log.
- **Split-Semantik** (1:1-Spiegel des Sidecar-`BuildPlanner`): pro Geschlecht
  werden die ADDON-Drawables in Revisionsreihenfolge in flache
  `splitAt`-Chunks (Default 128, YMT-Limit) geteilt; Part k = Chunk k beider
  Geschlechter, bei >1 Part bekommt JEDER Part das Suffix `_partN` auf
  Resource-Ordner UND dlcName. `NNN` = Index im `(part, gender, slot)`-Bucket
  (startet pro Part bei 000). Replace-Drawables landen ohne DLC-Präfix in
  Part 1 (`NNN` = `replaceTargetId`), nie in YMT/Shop-Meta. Props behalten
  ihr `p_`-Slot-Präfix im Stream-Namen. Shop-Metas: ein Geschlecht →
  `shop_ped_apparel.meta`, beide → `shop_ped_apparel_m.meta` +
  `shop_ped_apparel_f.meta`. Stream-Namen, Shop-Metas und `fxmanifest.lua`
  sind **byte-identisch** zum Desktop-Build (per Integrations-Diff
  verifiziert) — nur YMTs (fehlen serverseitig), `atelier-build.json` und
  `ATELIER_README.txt` unterscheiden sich.
- **Creative-Import:** componentId→Slot folgt creatives eigener Semantik
  (`7=accs`, `8=teef` — in creative vertauscht ggü. der kanonischen Reihenfolge,
  `5=hand` auch für „task“-Dateien), damit importierte Packs exakt den Slot
  behalten, den die creative-UI angezeigt hat. Gender: male, außer
  `scope.pedGender == "female"`. Fehlende Dateien → `skipped[]`.

## Starten

```bash
bun install
cp .env.example .env.local   # Werte ausfüllen
bun run dev                  # mit --watch
bun run start                # ohne watch
bun run lint                 # tsc --noEmit
bun run smoke                # E2E-Test (Server muss laufen, Fake-Mode aktiv)
bun run sync-roundtrip       # Push/Pull-Roundtrip wie ihn die App fährt
```

## curl-Beispiele

```bash
# Health
curl http://127.0.0.1:3095/health

# 1) Login starten (Fake-Mode: sofort 302 mit Code; sonst 302 zu Discord)
curl -i "http://127.0.0.1:3095/api/v1/auth/discord/start?redirect_uri=http://127.0.0.1:53682/callback"
# -> Location: http://127.0.0.1:53682/callback?code=<32hex>

# 2) Code gegen Tokens tauschen
curl -X POST http://127.0.0.1:3095/api/v1/auth/device/exchange \
  -H 'content-type: application/json' \
  -d '{"code":"<32hex>","redirect_uri":"http://127.0.0.1:53682/callback","device":{"name":"Mein PC","platform":"windows","appVersion":"0.1.0"}}'

# 3) Authentifizierte Requests
curl http://127.0.0.1:3095/api/v1/me -H "authorization: Bearer <accessToken>"
curl http://127.0.0.1:3095/api/v1/devices -H "authorization: Bearer <accessToken>"

# 4) Access-Token erneuern (Refresh-Token ROTIERT dabei!)
curl -X POST http://127.0.0.1:3095/api/v1/auth/device/refresh \
  -H 'content-type: application/json' \
  -d '{"refreshToken":"<96hex>"}'

# 5) Admin: pending User freischalten
curl http://127.0.0.1:3095/api/v1/admin/users?status=pending -H "authorization: Bearer <adminToken>"
curl -X POST http://127.0.0.1:3095/api/v1/admin/users/<discordId>/approve -H "authorization: Bearer <adminToken>"

# 6) Service-zu-Service
curl http://127.0.0.1:3095/api/v1/internal/ping -H "x-fg-service-token: <ATELIER_SERVICE_TOKEN>"
```

## Discord-App anlegen

1. <https://discord.com/developers/applications> → **New Application** → Name z. B. `atelier by feelgood`.
2. Links **OAuth2** öffnen.
3. **Client ID** kopieren → `ATELIER_DISCORD_CLIENT_ID`.
4. **Reset Secret** → **Client Secret** kopieren → `ATELIER_DISCORD_CLIENT_SECRET`.
5. Unter **Redirects** exakt eintragen (BEIDE):
   - `{ATELIER_PUBLIC_ORIGIN}/api/v1/auth/discord/callback` — Desktop-App-Login
   - `{ATELIER_PUBLIC_ORIGIN}/admin/callback` — Web-Admin-Dashboard
   (lokal also `http://127.0.0.1:3095/api/v1/auth/discord/callback`
   bzw. `http://127.0.0.1:3095/admin/callback`).
6. Scope `identify` reicht — wird vom Service automatisch angefragt.
7. `ATELIER_DEV_FAKE_AUTH=0` setzen (sobald echte Creds da sind, deaktiviert
   sich der Fake-Mode auch von selbst).

## Admin-Dashboard (Web)

Browser-Dashboard unter **`{ATELIER_PUBLIC_ORIGIN}/admin`** — Login nur fuer
Discord-IDs aus `ATELIER_ADMIN_DISCORD_IDS` (eigener Discord-Web-Login getrennt
vom Desktop-Loopback-Flow; signiertes HttpOnly-Session-Cookie, 12 h, Admin-Check
bei jedem Request). Bietet:

- **Uebersicht** — Speichergroesse (CAS/Builds/tmp) + Kennzahlen (Assets, Packs,
  Revisionen, Builds, Nutzer).
- **Logs** — Live-Server-Logs (SSE) + Aktivitaets-Audit (`atelierActivity`).
- **Packs & Builds** — Server-Build pro Revision erzeugen/neu bauen, fertige
  Pakete als **ZIP** herunterladen.
- **fxmanifest & Build-Config** — pro Pack ein Resource-Name- und
  `fxmanifest.lua`-Template-Override (Platzhalter `{{files}}` / `{{data_files}}`);
  betrifft nur Server-Builds und greift beim naechsten Build. Ohne Override bleibt
  das Manifest byte-identisch zum Desktop-Build.
- **Nutzer** — freischalten / sperren.

Voraussetzung: echte Discord-Creds + die `/admin/callback`-Redirect-URI (siehe
oben). Lokal mit Fake-Auth loggt `/admin/login` direkt als
`ATELIER_DEV_FAKE_DISCORD_ID` ein (muss in `ATELIER_ADMIN_DISCORD_IDS` stehen).

## Docker & CI

- **Docker:** `docker build -t atelier-api .` — Image auf `oven/bun:1`,
  CAS-Storage als Volume unter `/data` (`ATELIER_STORAGE_ROOT`), Healthcheck
  auf `GET /health`, laeuft als unprivilegierter `bun`-User. Hinter
  Reverse-Proxy `ATELIER_TRUST_PROXY=1` setzen. Beispiel:

  ```sh
  docker build -t atelier-api .
  docker run -d --name atelier-api \
    -p 3095:3095 \
    -v atelier-data:/data \
    --env-file .env.docker \
    atelier-api
  ```

- **CI** (`.github/workflows/ci.yml`, PRs + master + Tags): Typecheck, dann
  die komplette Smoke-Suite (120 Checks) + Sync-Roundtrip (15 Checks) gegen
  einen live gestarteten Server mit Dev-Fake-Auth und einem
  `mongo:7`-Service-Container, plus `docker build` als reines
  Dockerfile-Gate. Es wird BEWUSST kein Image in eine Registry gepusht —
  das Deployment baut das Image direkt auf dem Zielhost aus dem Repo.
