# P0-6b - image for @infinicus/event-worker, the SEPARATE dispatcher process (never part of the API container).
# Build from the monorepo root (infinicus-platform/):
#   docker build -f infrastructure/deployment/event-worker/Dockerfile -t infinicus-event-worker:<version> .
FROM node:22-bookworm-slim AS base
RUN corepack enable

FROM base AS build
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN npx turbo run build --filter=@infinicus/event-worker...

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /repo
RUN groupadd --system --gid 1001 infinicus && \
    useradd --system --uid 1001 --gid infinicus infinicus
COPY --from=build --chown=infinicus:infinicus /repo /repo
USER infinicus
WORKDIR /repo/packages/event-worker
CMD ["node", "dist/main.js"]
