# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps --no-audit --no-fund

COPY . .

RUN npm run prisma:generate
RUN npm run build && test -f dist/main.js
FROM node:22-alpine AS production-deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --legacy-peer-deps --omit=dev --no-audit --no-fund

FROM node:22-alpine AS runner

WORKDIR /app

RUN --mount=type=cache,target=/root/.npm \
    npm install -g @circle-fin/cli --no-audit --no-fund

ENV NODE_ENV=production
ENV PORT=4000

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/database ./src/database
COPY --from=builder /app/prisma.config.ts ./prisma.config.ts

EXPOSE 4000

COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
