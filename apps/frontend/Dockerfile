FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json .npmrc ./
RUN npm ci

FROM node:20-alpine AS builder

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ARG NEXT_PUBLIC_CONTRACT_ADDRESS=
ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_BACKEND_API_BASE_URL=
ARG NEXT_PUBLIC_RPC_URL=
ARG NEXT_PUBLIC_ARC_TESTNET_RPC_URL=
ARG DOCKER_BUILD=true

ENV NEXT_PUBLIC_CONTRACT_ADDRESS=$NEXT_PUBLIC_CONTRACT_ADDRESS
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_BACKEND_API_BASE_URL=$NEXT_PUBLIC_BACKEND_API_BASE_URL
ENV NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL
ENV NEXT_PUBLIC_ARC_TESTNET_RPC_URL=$NEXT_PUBLIC_ARC_TESTNET_RPC_URL
ENV DOCKER_BUILD=$DOCKER_BUILD

RUN npm run build -- --no-lint

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

COPY package.json package-lock.json .npmrc ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm cache clean --force

COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts
COPY --from=builder /app/lib/shims ./lib/shims

EXPOSE 3000

CMD ["npm", "start"]