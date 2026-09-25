# The Glance API (with the in-process feed keeper) for Railway: builds and runs only apps/api, Node 22, on $PORT.
# Build context: the repository root (railway.json points here). @glance/core, @glance/design and the keeper are
# TypeScript sources that Node 22 runs as they are (type stripping), so they keep their workspace paths.
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/keeper/package.json apps/keeper/
COPY packages/core/package.json packages/core/
COPY packages/design/package.json packages/design/

FROM base AS build
RUN pnpm install --frozen-lockfile --filter "api..."
COPY packages/core/ packages/core/
COPY packages/design/ packages/design/
COPY apps/keeper/ apps/keeper/
COPY apps/api/ apps/api/
RUN pnpm --filter api build

FROM base AS run
ENV NODE_ENV=production
RUN pnpm install --frozen-lockfile --prod --filter "api..."
COPY packages/core/src packages/core/src
COPY packages/design/src packages/design/src
COPY apps/keeper/src apps/keeper/src
COPY apps/api/data/catalog.json apps/api/data/catalog.json
COPY deployments/46630.json deployments/46630.json
COPY config/ config/
COPY --from=build /app/apps/api/dist apps/api/dist
WORKDIR /app/apps/api
# Runs as root so it can write to a Railway volume (volumes are mounted owned by root). DATA_DIR is that volume.
CMD ["node", "dist/index.js"]
