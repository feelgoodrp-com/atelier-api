# atelier-api — Bun-Service (Port 3095)
#
#   docker build -t atelier-api .
#   docker run -d -p 3095:3095 -v atelier-data:/data --env-file .env.docker atelier-api
#
# PERSISTENZ (WICHTIG): der komplette Storage liegt unter /data
# (/data/cas Assets, /data/builds Build-ZIPs, /data/tmp Uploads). Es MUSS ein
# BENANNTES Volume an /data gemountet werden, sonst gehen bei jedem Redeploy alle
# Uploads verloren.
#   - docker:  -v atelier-data:/data   (siehe oben)
#   - Dokploy: App → Advanced → Volumes/Mounts → "Volume Mount" hinzufuegen:
#              Volume Name = atelier-api-data, Mount Path = /data → Redeploy.
# Kein `VOLUME /data` mehr: das erzeugt sonst pro Redeploy ein NEUES, leeres
# anonymes Volume (= genau der Datenverlust).
#
# Pflicht-Env zur Laufzeit: MONGODB_URI, ATELIER_JWT_SECRET, ATELIER_SERVICE_TOKEN,
# ATELIER_PUBLIC_ORIGIN + Discord-Creds/Admin-IDs (siehe .env.example).
# Hinter Reverse-Proxy zusaetzlich ATELIER_TRUST_PROXY=1 setzen.

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3095 \
    ATELIER_STORAGE_ROOT=/data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY assets ./assets

# /data vorab anlegen + dem Runtime-User geben, damit ein frisch gemountetes
# benanntes Volume die richtige Ownership erbt. KEIN `VOLUME /data` (s.o.) —
# der Betreiber mountet ein benanntes Volume an /data (docker -v / Dokploy).
RUN mkdir -p /data && chown bun:bun /data

EXPOSE 3095
USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || '3095') + '/health'); if (!r.ok) process.exit(1);"]

CMD ["bun", "run", "src/index.ts"]
