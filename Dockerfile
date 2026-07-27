# ── chain-indexer Dockerfile ────────────────────────────────────────────
# Rug Munch Media fleet standard
# Multi-stage: production image for blockchain data ingestion
# ──────────────────────────────────────────────────────────────────────────

FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
# Install ALL deps (tsx is a devDependency, needed at runtime for loader)
RUN npm install --ignore-scripts

# ── Runtime image ───────────────────────────────────────────────────────

FROM node:22-slim

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY tsconfig.json ./
COPY src/ ./src/

VOLUME ["/data"]

ENV NODE_ENV=production

ENTRYPOINT ["node", "--import", "tsx", "src/index.ts"]
