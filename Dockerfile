# syntax=docker/dockerfile:1.7

# ─── 1. build stage ─────────────────────────────────────────────────────────
# pnpm workspace, install + typecheck + build. Heavier image, discarded
# after extraction.
FROM node:20-bookworm-slim AS build

# Install pnpm via corepack (shipped with Node 20).
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /src

# Copy workspace manifest + each package's package.json first, install
# dependencies, THEN copy source. Lets Docker cache `pnpm install` across
# source-only edits.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json            packages/core/package.json
COPY packages/protocol/package.json        packages/protocol/package.json
COPY packages/transport-ws/package.json    packages/transport-ws/package.json
COPY packages/sdk-node/package.json        packages/sdk-node/package.json
COPY packages/web/package.json             packages/web/package.json
COPY packages/host/package.json            packages/host/package.json
COPY packages/llm/package.json             packages/llm/package.json
COPY packages/llm-anthropic/package.json   packages/llm-anthropic/package.json
COPY packages/llm-openai/package.json      packages/llm-openai/package.json

# Use the lockfile verbatim. We don't add --frozen-lockfile because the
# image is built from the repo, not from a fresh clone — but pnpm will
# still refuse divergent lockfiles in CI mode.
RUN pnpm install --frozen-lockfile

# Now source.
COPY packages ./packages
COPY tsconfig*.json ./

RUN pnpm -r build

# ─── 2. runtime stage ───────────────────────────────────────────────────────
# Slim image, only built dist + production-pruned node_modules.
FROM node:20-bookworm-slim AS runtime

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy workspace manifests (pnpm prune needs them).
COPY --from=build /src/package.json /src/pnpm-workspace.yaml /src/pnpm-lock.yaml ./
COPY --from=build /src/packages ./packages

# Re-install production-only (no dev deps, no tsx/vitest).
RUN pnpm install --frozen-lockfile --prod \
 && pnpm store prune \
 && find /app -name '*.map' -delete \
 && find /app -name 'tsconfig*.json' -delete

# Default workspace dir lives under /data — pair with `volume:` in
# docker-compose or `-v` on `docker run` so transcripts survive container
# restarts.
ENV AIPE_SPACE=/data \
    AIPE_HOST=0.0.0.0 \
    AIPE_WEB_PORT=3000 \
    AIPE_WS_PORT=4000 \
    AIPE_GATING=admin-approval \
    NODE_ENV=production

# Run as the unprivileged `node` user shipped with the base image; create
# /data with permissive enough perms for the volume mount.
RUN install -d -o node -g node /data
USER node

EXPOSE 3000 4000

# Bare-metal healthcheck — /healthz is unauthenticated and answers 200 ok.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.AIPE_WEB_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Use the published bin shim so the entrypoint is the same one `npx
# @aipehub/host` would invoke. If you want to override (e.g. exec a
# debug shell), pass `--entrypoint /bin/sh` on `docker run`.
ENTRYPOINT ["node", "packages/host/bin/aipehub-host.js"]
