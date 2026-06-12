# syntax=docker/dockerfile:1.7

# ─── 1. build stage ─────────────────────────────────────────────────────────
# pnpm workspace, install + typecheck + build. Heavier image, discarded
# after extraction.
#
# Uses the *non-slim* node:20-bookworm so python3 + g++ + make are on
# PATH for native-module builds. better-sqlite3 12.x's prebuild-install
# falls back to node-gyp when it can't resolve a prebuilt binary
# (intermittently true on Docker hub-bookworm-slim — its trimmed cert
# store + missing build tools mean the fallback then explodes). The
# runtime stage below stays on slim, so the production image size is
# unaffected.
FROM node:20-bookworm AS build

# Install pnpm via corepack (shipped with Node 20).
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /src

# Heavy network layer first: `pnpm fetch` populates the store from the
# lockfile ALONE, so this layer only re-runs when pnpm-lock.yaml changes.
# The workspace has 75 importers (packages/* + examples/*) and the old
# hand-maintained per-package COPY list silently drifted to 17 of them,
# which made `pnpm install --frozen-lockfile` fail outright (frozen mode
# refuses a lockfile whose importers aren't all present). Fetch-then-
# offline-install removes the drift class entirely: no manifest list to
# keep in sync when a package or example is added.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
RUN pnpm fetch

# Now source (examples are workspace importers too — their manifests must
# be present for the frozen install, and none of them define a build
# script, so `pnpm -r build` skips them). Offline install just hardlinks
# from the already-fetched store — cheap, runs on any source edit.
COPY packages ./packages
COPY examples ./examples
COPY tsconfig*.json ./

RUN pnpm install --frozen-lockfile --offline

RUN pnpm -r build

# ─── 2. runtime stage ───────────────────────────────────────────────────────
# Only built dist + production-pruned node_modules.
#
# Also uses non-slim node:20-bookworm because `pnpm install --prod`
# below re-runs better-sqlite3's install script, which needs the same
# python3 + g++ + make toolchain when the prebuilt binary resolution
# falls through. Image grows by ~100 MB vs slim; an optimisation pass
# using `pnpm deploy` or a distroless final stage is tracked for
# later.
FROM node:20-bookworm AS runtime

RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /app

# Copy workspace manifests (pnpm prune needs them). examples/ rides along
# because frozen-lockfile installs validate ALL importers, examples
# included — they're a few hundred KB of demo source, never executed here.
COPY --from=build /src/package.json /src/pnpm-workspace.yaml /src/pnpm-lock.yaml ./
COPY --from=build /src/packages ./packages
COPY --from=build /src/examples ./examples

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
