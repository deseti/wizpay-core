# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS workspace-deps

WORKDIR /repo

# Keep the deterministic dependency layer independent from application source.
COPY package.json package-lock.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY packages/bridge-registry/package.json ./packages/bridge-registry/package.json
COPY packages/contracts/package.json ./packages/contracts/package.json
RUN --mount=type=cache,id=wizpay-npm-v1,target=/root/.npm,sharing=locked \
    set -eu; attempt=1; \
    while :; do \
      if npm ci --legacy-peer-deps --no-audit --no-fund --prefer-offline \
        > /tmp/npm-ci.log 2>&1; then \
        cat /tmp/npm-ci.log; break; \
      fi; \
      cat /tmp/npm-ci.log; \
      if [ "$attempt" -ge 2 ] || \
        ! grep -Eq 'ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_SOCKET|npm error network' /tmp/npm-ci.log; then \
        exit 1; \
      fi; \
      attempt=2; \
      echo 'npm ci hit a transient network failure; retrying once.'; \
    done

FROM workspace-deps AS builder

COPY apps/backend ./apps/backend
COPY packages/bridge-registry ./packages/bridge-registry
RUN npm run prisma:generate -w backend
RUN npm run build -w backend && test -f apps/backend/dist/main.js

FROM workspace-deps AS production-deps

# Reuse the populated npm cache, then retain only backend production packages.
RUN --mount=type=cache,id=wizpay-npm-v1,target=/root/.npm,sharing=locked \
    rm -rf node_modules && \
    npm ci --legacy-peer-deps --omit=dev --workspace backend \
      --include-workspace-root=false --no-audit --no-fund --offline

FROM production-deps AS circle-cli

# The registered fail-closed official-swap runtime probes and invokes this CLI.
RUN --mount=type=cache,id=wizpay-npm-v1,target=/root/.npm,sharing=locked \
    npm install --global @circle-fin/cli@1.0.0 --no-audit --no-fund --prefer-offline

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000

COPY --from=circle-cli /usr/local/lib/node_modules/@circle-fin/cli /usr/local/lib/node_modules/@circle-fin/cli
COPY --from=circle-cli /usr/local/bin/circle /usr/local/bin/circle
COPY --from=production-deps /repo/node_modules ./node_modules
COPY --from=builder /repo/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /repo/packages/bridge-registry ./packages/bridge-registry
COPY --from=builder /repo/apps/backend/dist ./dist
COPY --from=builder /repo/apps/backend/src/database ./src/database
COPY --from=builder /repo/apps/backend/prisma.config.ts ./prisma.config.ts
COPY --from=builder /repo/apps/backend/package.json ./package.json
COPY --chown=node:node --chmod=755 --from=builder /repo/apps/backend/docker-entrypoint.sh ./docker-entrypoint.sh

USER node

EXPOSE 4000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
