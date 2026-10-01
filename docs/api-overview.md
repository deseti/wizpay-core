---
title: "API Reference"
description: "Implemented application routes for wallet-signed payments."
---

# API Reference

Use the backend origin configured for the application by `NEXT_PUBLIC_API_URL`. Paths below are relative to that origin; do not assume that a separate service's hostname or API belongs to WizPay Core.

Availability is determined by `GET /capabilities` and operation-specific readiness. Account-scoped endpoints require the wallet session issued by the authentication flow. Execution-intent endpoints also validate the intent's access key and, where required, its active lease.

## Health and Capabilities

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Backend health response |
| GET | `/capabilities` | Selected network and runtime feature flags |

Feature names include `send`, `sameTokenPayroll`, `invoice`, `paymentLink`, `bridge`, `swap`, and `crossTokenPayroll`. Only enabled, ready routes may be used.

## Wallet Authentication

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/wallets/auth/challenge` | Request a message for an address on chain 5042 |
| POST | `/wallets/auth/verify` | Verify the challenge ID and signature |
| POST | `/wallets/auth/revoke` | Revoke the authenticated session |

Use `Authorization: Bearer <session-token>` where wallet-session authentication is required. Never send a private key to these endpoints.

## Execution Intents

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/execution-intents/acquire` | Acquire the operation's durable identity |
| POST | `/execution-intents/:id/prepare-wallet` | Prepare wallet signing under a lease |
| POST | `/execution-intents/:id/transaction-hash` | Bind the submitted hash |
| POST | `/execution-intents/:id/recover` | Retrieve the existing intent after an interruption |
| POST | `/execution-intents/:id/recover-hash` | Recover a known hash for the existing intent |
| POST | `/execution-intents/:id/cancel` | Cancel an eligible unsubmitted intent |
| POST | `/execution-intents/:id/verify` | Verify a submitted direct Send intent |

These operations preserve the same intent identity. `/verify` supports direct Send; it is not a generic verifier for every payment type.

## Payroll

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/tasks/payroll/init` | Validate and prepare batch units |
| POST | `/tasks/:taskId/units/:unitId/report` | Report a unit result; successful payroll reports are verified |
| GET | `/tasks` | List tasks for the authenticated wallet |
| GET | `/tasks/:id` | Read a task owned by the authenticated wallet |
| GET | `/tasks/:id/employee-breakdown` | Read verified employee-level payroll details |
| GET | `/tasks/payroll/history` | Read payroll history for the requested wallet |

Initialization is preparation, not backend payment submission. Use the payload returned by the current planning flow rather than inventing token addresses or approval amounts.

## Invoices and Payment Links

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/invoices` | Create a merchant payment request |
| GET | `/invoices` | List the merchant's invoices |
| GET | `/invoices/:id` | Read a merchant-owned invoice |
| POST | `/invoices/:id/cancel` | Cancel an eligible invoice |
| GET | `/public/invoices/:publicId` | Read the public checkout details |
| POST | `/public/invoices/:publicId/payments/verify` | Verify a payer's submitted transaction |

Payment links use the invoice model's settlement kind. Merchant operations require a wallet session; public checkout routes use their own validation and rate limits.

## Activity

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/activities` | List authenticated account activity |
| GET | `/activities/:id` | Read an owned activity record |
| POST | `/activities/sync` | Synchronize the authenticated account's activity |

## Conditional Swap and Bridge Routes

Only use these routes when the corresponding runtime capability and readiness checks pass.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/user-swap/mainnet/readiness` | Inspect Mainnet swap readiness |
| POST | `/user-swap/mainnet/quote` | Inspect a swap quote |
| POST | `/user-swap/mainnet/prepare` | Prepare wallet execution |
| POST | `/user-swap/mainnet/payroll-quote` | Inspect a cross-token payroll quote |
| POST | `/user-swap/mainnet/confirm` | Verify and record the authenticated wallet's swap |
| POST | `/bridge/intents` | Create a bridge intent |
| GET | `/bridge/intents/:id` | Read a bridge intent |

Bridge continuation uses the intent's approval, source, attestation, and destination lifecycle endpoints. A successful source transaction does not complete the destination transfer.

Legacy generic task submission, worker-signed payroll/swap, standalone FX, liquidity execution, hosted-wallet onboarding, and paid preparation APIs from other repositories are not documented as production application integrations.
