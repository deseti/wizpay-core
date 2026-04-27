FROM node:20-alpine AS builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

COPY package.json package-lock.json ./
RUN npm install --legacy-peer-deps

COPY . .

# ── Build-time env vars ───────────────────────────────────────────────────────
# Each ARG receives its value from docker-compose build.args (which reads from
# root .env). The ENV lines bake the values into the Next.js bundle so they are
# available as process.env.NEXT_PUBLIC_* in browser code.
#
# To add a new public var: add ARG + ENV here AND in docker-compose build.args
# AND in the root .env file.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_BACKEND_API_BASE_URL=http://localhost:4000
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID=
ARG NEXT_PUBLIC_CIRCLE_APP_ID=
ARG NEXT_PUBLIC_CIRCLE_PASSKEY_CLIENT_KEY=
ARG NEXT_PUBLIC_CIRCLE_PASSKEY_CLIENT_URL=
ARG NEXT_PUBLIC_RPC_URL=
ARG NEXT_PUBLIC_ARC_TESTNET_RPC_URL=

ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_BACKEND_API_BASE_URL=$NEXT_PUBLIC_BACKEND_API_BASE_URL
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_CLIENT_ID
ENV NEXT_PUBLIC_CIRCLE_APP_ID=$NEXT_PUBLIC_CIRCLE_APP_ID
ENV NEXT_PUBLIC_CIRCLE_PASSKEY_CLIENT_KEY=$NEXT_PUBLIC_CIRCLE_PASSKEY_CLIENT_KEY
ENV NEXT_PUBLIC_CIRCLE_PASSKEY_CLIENT_URL=$NEXT_PUBLIC_CIRCLE_PASSKEY_CLIENT_URL
ENV NEXT_PUBLIC_RPC_URL=$NEXT_PUBLIC_RPC_URL
ENV NEXT_PUBLIC_ARC_TESTNET_RPC_URL=$NEXT_PUBLIC_ARC_TESTNET_RPC_URL

RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["node", "server.js"]