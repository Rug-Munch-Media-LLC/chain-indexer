# ── chain-indexer Dockerfile ────────────────────────────────────────────
# Rug Munch Media fleet standard
# Single-stage: includes pre-installed node_modules (dev deps too)
# ──────────────────────────────────────────────────────────────────────────

FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
ADD node_modules.tar.gz /app/

COPY tsconfig.json ./
COPY src/ ./src/

VOLUME ["/data"]

ENV NODE_ENV=production

USER node

ENTRYPOINT ["node", "--import", "tsx", "src/index.ts"]
