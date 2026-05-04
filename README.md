# wizpay-core

Monorepo containing the WizPay frontend application, backend service, landing site, and smart contracts.

## Environment files

Use the root [.env.example](.env.example) as the primary reference for shared configuration.

- Root `.env`: primary source for Docker Compose, docker-compose.dev, backend local runs, and frontend local runs.
- `apps/backend/.env`: no longer used by default.
- `apps/frontend/.env.local`: no longer required for normal local development.
- `apps/frontend/.env.docker`: legacy local helper, not the primary source of truth.

## Local run modes

### Docker Compose

- Fill the root `.env`.
- Run `docker compose up --build` from the repo root.

### Frontend local Next.js

- Fill the root `.env`.
- Start the app from `apps/frontend` with `npm run dev`.

### Backend local NestJS

- Fill the root `.env`.
- Start the API from `apps/backend` with `npm run start:dev`.