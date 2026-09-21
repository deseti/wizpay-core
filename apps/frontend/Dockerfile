# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS workspace-deps

WORKDIR /repo

COPY package.json package-lock.json ./
COPY apps/backend/package.json ./apps/backend/package.json
COPY apps/frontend/package.json ./apps/frontend/package.json
COPY packages/arc-network/package.json ./packages/arc-network/package.json
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

ENV NEXT_TELEMETRY_DISABLED=1

COPY apps/frontend ./apps/frontend
COPY packages/arc-network ./packages/arc-network
COPY packages/bridge-registry ./packages/bridge-registry

# ── Build-time env vars ───────────────────────────────────────────────────────
# Each ARG receives its value from docker-compose build.args (which reads from
# root .env). The ENV lines bake the values into the Next.js bundle so they are
# available as process.env.NEXT_PUBLIC_* in browser code.
#
# To add a new public var: add ARG + ENV here AND in docker-compose build.args
# AND in the root .env file.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG WIZPAY_ARC_NETWORK=arc-mainnet
ARG NEXT_PUBLIC_BACKEND_API_BASE_URL=http://localhost:4000
ARG NEXT_PUBLIC_BACKEND_URL=
ARG NEXT_PUBLIC_WIZPAY_PUBLIC_APP_URL=http://localhost:3000
ARG NEXT_PUBLIC_INVOICE_API_PREFIX=
ARG NEXT_PUBLIC_REOWN_PROJECT_ID
ARG NEXT_PUBLIC_WIZPAY_AGENTIC_NANO_ADDRESS=

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV WIZPAY_ARC_NETWORK=$WIZPAY_ARC_NETWORK
ENV NEXT_PUBLIC_BACKEND_API_BASE_URL=$NEXT_PUBLIC_BACKEND_API_BASE_URL
ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL
ENV NEXT_PUBLIC_WIZPAY_PUBLIC_APP_URL=$NEXT_PUBLIC_WIZPAY_PUBLIC_APP_URL
ENV NEXT_PUBLIC_INVOICE_API_PREFIX=$NEXT_PUBLIC_INVOICE_API_PREFIX
ENV NEXT_PUBLIC_REOWN_PROJECT_ID=$NEXT_PUBLIC_REOWN_PROJECT_ID
ENV NEXT_PUBLIC_WIZPAY_AGENTIC_NANO_ADDRESS=$NEXT_PUBLIC_WIZPAY_AGENTIC_NANO_ADDRESS

RUN npm run build -w frontend

FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY --chown=node:node --from=builder /repo/apps/frontend/.next/standalone ./
COPY --chown=node:node --from=builder /repo/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --chown=node:node --from=builder /repo/apps/frontend/public ./apps/frontend/public
# React is a workspace root development dependency and is not always traced
# into Next's standalone output when the app is built from the monorepo root.
COPY --chown=node:node --from=builder /repo/node_modules/react ./node_modules/react
COPY --chown=node:node --from=builder /repo/node_modules/react-dom ./node_modules/react-dom
# Next standalone tracing in this workspace does not currently retain the
# framework runtime packages required by generated server.js.
COPY --chown=node:node --from=builder /repo/node_modules/styled-jsx ./node_modules/styled-jsx

USER node

EXPOSE 3000

CMD ["node", "apps/frontend/server.js"]
