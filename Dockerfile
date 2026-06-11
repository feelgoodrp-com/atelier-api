# atelier-api — Bun-Service (Port 3095)
#
#   docker build -t atelier-api .
#   docker run -d -p 3095:3095 -v atelier-data:/data --env-file .env.docker atelier-api
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

# CAS-Storage liegt im Volume; vorab anlegen, damit anonyme Volumes dem
# Runtime-User gehoeren (Bind-Mounts muss der Betreiber selbst beschreibbar machen).
RUN mkdir -p /data && chown bun:bun /data
VOLUME /data

EXPOSE 3095
USER bun

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch('http://127.0.0.1:' + (process.env.PORT || '3095') + '/health'); if (!r.ok) process.exit(1);"]

CMD ["bun", "run", "src/index.ts"]
