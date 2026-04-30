# wizpay-core

Monorepo containing the WizPay frontend application, backend service, landing site, and smart contracts.

## Environment files

Use the root [.env.example](.env.example) as the primary reference for shared configuration.

- Root `.env`: primary source for Docker Compose and backend local fallback loading.
- `apps/backend/.env`: optional backend-only override; use only when you explicitly need to bypass the root file.
- `apps/frontend/.env.local`: local Next.js development file for the frontend.
- `apps/frontend/.env.docker`: legacy local helper, not the primary source of truth.

## Local run modes

### Docker Compose

- Fill the root `.env`.
- Run `docker compose up --build` from the repo root.

### Frontend local Next.js

- Copy `apps/frontend/.env.example` to `apps/frontend/.env.local`.
- Start the app from `apps/frontend` with `npm run dev`.

### Backend local NestJS

- Prefer filling the root `.env`.
- Start the API from `apps/backend` with `npm run start:dev`.