# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder

WORKDIR /repo

COPY . .
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps --no-audit --no-fund

RUN npm run prisma:generate -w backend
RUN npm run build -w backend && test -f apps/backend/dist/main.js
FROM node:22-alpine AS production-deps

WORKDIR /repo

COPY . .
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runner

WORKDIR /app

RUN --mount=type=cache,target=/root/.npm \
    npm install -g @circle-fin/cli --no-audit --no-fund

ENV NODE_ENV=production
ENV PORT=4000

COPY --from=builder /repo/apps/backend/package.json ./package.json
COPY --from=builder /repo/package-lock.json ./package-lock.json
COPY --from=production-deps /repo/node_modules ./node_modules
COPY --from=builder /repo/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /repo/packages/bridge-registry ./packages/bridge-registry
COPY --from=builder /repo/apps/backend/dist ./dist
COPY --from=builder /repo/apps/backend/src/database ./src/database
COPY --from=builder /repo/apps/backend/prisma.config.ts ./prisma.config.ts

EXPOSE 4000

COPY apps/backend/docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
