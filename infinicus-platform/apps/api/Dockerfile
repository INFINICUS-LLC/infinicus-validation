# BUILD-23 — Immutable build image for @infinicus/api.
#
# Multi-stage: install+build the whole pnpm workspace (apps/api needs its
# workspace:* dependencies — @infinicus/database, @infinicus/configuration,
# @infinicus/observability, @infinicus/authentication, @infinicus/authorization,
# @infinicus/onboarding, @infinicus/workflow — built alongside it, not just
# apps/api in isolation), then copy only the compiled output and production
# node_modules into a slim runtime stage.
#
# Build from the monorepo root (infinicus-platform/), not from apps/api/:
#   docker build -f apps/api/Dockerfile -t infinicus-api:<version> .
#
# <version> should come from infrastructure/deployment/scripts/version.sh
# — see docs/production-readiness/architecture-and-scope-build23.md for why
# a version derived from exact git state is what makes this image
# "immutable" in the sense spec §2 requires (the same version always
# means the same image contents).

FROM node:22-bookworm-slim AS base
RUN corepack enable

# ---- deps+build stage -------------------------------------------------
FROM base AS build
WORKDIR /repo

# Full workspace context — a partial/layer-cache-optimized COPY was
# deliberately not attempted here, since this environment's Docker
# daemon cannot reach a container registry to pull a base image and
# iteratively verify a more clever multi-COPY caching strategy actually
# works (see known-limitations-build23.md). Correctness over build-cache
# optimization.
COPY . .
RUN pnpm install --frozen-lockfile
RUN npx turbo run build --filter=@infinicus/api...

# ---- runtime stage ------------------------------------------------------
FROM base AS runtime
# The git commit this image was built from, reported by GET /v1/health so an operator can tell which code is deployed.
# Pass it at build time: `GIT_SHA=$(git rev-parse HEAD) docker compose build` (defaults to "unknown").
ARG GIT_SHA=unknown
ENV NODE_ENV=production
ENV INFINICUS_BUILD_SHA=$GIT_SHA
WORKDIR /repo

# Non-root — least privilege for the running process (spec §5).
RUN groupadd --system --gid 1001 infinicus && \
    useradd --system --uid 1001 --gid infinicus infinicus

COPY --from=build --chown=infinicus:infinicus /repo /repo

USER infinicus
WORKDIR /repo/apps/api

EXPOSE 3000

# Reuses BUILD-22's real readiness check — an image that can't reach its
# own database is correctly reported unhealthy, not silently "running."
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/v1/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/server.js"]
