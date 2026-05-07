# Circle Google Login Audit

## Scope

This checklist covers the Google social login flow used by the existing Circle User-Controlled Wallet integration in this repo. It is based on the current frontend and backend implementation, not on a hypothetical future auth stack.

Key runtime anchors:

- `NEXT_PUBLIC_CIRCLE_APP_ID`
- `NEXT_PUBLIC_GOOGLE_CLIENT_ID`
- `CIRCLE_API_KEY`
- Google redirect URI derived from `window.location.origin`

Relevant code paths:

- frontend Google login config is built in `apps/frontend/services/circle-auth.service.ts`
- the login config uses `window.location.origin` as the redirect URI
- backend wallet persistence happens through `POST /wallets/initialize`, `POST /wallets/sync`, and `POST /wallets/ensure`

## Symptom Map

Use the symptom first, then jump to the matching checklist item.

### `155114`

The Circle app ID does not match the active wallet app.

Check:

1. `NEXT_PUBLIC_CIRCLE_APP_ID`
2. the active User-Controlled Wallet app in Circle Console
3. whether the frontend env was updated after creating a new Circle app

### `155140` after browser-side checks already passed

State, nonce, and client ID looked valid in the browser, but Circle still rejected the Google token.

Most likely cause:

1. the Google client ID is not enabled on the same Circle User-Controlled Wallet app as `NEXT_PUBLIC_CIRCLE_APP_ID`

### `POST /wallets/sync` fails with `DATABASE_UNREACHABLE`

This is not a Google OAuth misconfiguration.

Most likely cause:

1. the backend is running on the host with Docker-only env values such as `DATABASE_URL=...@postgres:5432/...`
2. Postgres is not reachable from the host runtime

## Required Circle Console Checks

### 1. Project And Environment Match

Confirm these belong to the same Circle project and environment:

1. `CIRCLE_API_KEY`
2. `NEXT_PUBLIC_CIRCLE_APP_ID`
3. the Google social login provider attached to the Circle app

Do not mix:

1. a test API key with a live Circle app
2. a live API key with a test Circle app
3. a Google provider attached to a different Circle project

### 2. The App ID Really Points To The Active UCW App

Open Circle Console and verify that `NEXT_PUBLIC_CIRCLE_APP_ID` is the exact app ID of the User-Controlled Wallet app used for Google login in this repo.

If you recently recreated the Circle app, rotate the frontend env as well. Reusing the old app ID after migrating the Google provider is a common failure mode.

### 3. Google Is Enabled On That Exact App

Inside Circle Console, verify that Google social login is enabled on the same UCW app referenced by `NEXT_PUBLIC_CIRCLE_APP_ID`.

Do not assume a Google provider enabled on another UCW app in the same project will work here.

### 4. The Google Client ID Matches The App Configuration

Verify that the Google OAuth client configured in Circle Console is exactly the same value as `NEXT_PUBLIC_GOOGLE_CLIENT_ID`.

If Circle rejects the token after the browser-side state, nonce, and client ID checks pass, this is the first thing to re-check.

### 5. Redirect URI And Origin Match The Current Frontend Runtime

This repo builds the Google login config with `window.location.origin` as the redirect URI.

That means the Google OAuth client must allow the exact frontend origin you are using, for example:

1. `http://localhost:3000` for local dev
2. the production origin for the deployed app
3. any staging origin you actually use

If you run the frontend on a different local port, that exact origin must also be allowed.

### 6. The Redirect Destination Must Match What The Repo Sends

Because the redirect URI is derived from the page origin, do not whitelist only a backend callback URL if the browser is actually returning to the frontend origin.

For this repo, the safe assumption is:

1. the Google redirect comes back to the frontend origin
2. Circle validates that returned Google token against the app and provider configuration

### 7. Google OAuth Consent Configuration Must Cover The Active Origin

Check the Google Cloud OAuth client used by `NEXT_PUBLIC_GOOGLE_CLIENT_ID` and confirm:

1. authorized JavaScript origins include the active frontend origin
2. authorized redirect URIs include the same frontend origin used by this repo
3. the OAuth client is not disabled or rotated without updating env

### 8. Old Browser State Must Be Cleared After Config Changes

If you changed the Circle app ID, Google client ID, or redirect setup, clear old OAuth state before retrying.

This repo caches:

1. OAuth state
2. OAuth nonce
3. Circle device token
4. Circle device encryption key
5. Google client ID markers in cookies and local storage

Without clearing those, the browser can look partially correct while still replaying stale pre-login state.

### 9. Email OTP Fallback Should Still Work

If Google login fails but email OTP succeeds, that usually narrows the issue to Circle app and Google provider configuration, not the whole W3S integration.

### 10. Backend Wallet Sync Is A Separate Layer

A successful Google redirect is still followed by backend wallet initialization and sync.

If login reaches backend wallet sync and then fails, audit these separately:

1. `DATABASE_URL`
2. Postgres reachability
3. `REDIS_HOST` only if background workers are part of the failing flow

In local host-run mode, Docker-only hosts such as `postgres` and `redis` must be translated to host-reachable values.

## Recommended Verification Order

1. Confirm `NEXT_PUBLIC_CIRCLE_APP_ID` and `NEXT_PUBLIC_GOOGLE_CLIENT_ID` in env.
2. Confirm both values point to the same UCW app in Circle Console.
3. Confirm Google is enabled on that app.
4. Confirm Google Cloud origins and redirect URIs include the exact frontend origin.
5. Clear browser OAuth state and retry.
6. If Google login now succeeds but `/wallets/sync` fails, switch to backend env validation rather than Circle Console debugging.