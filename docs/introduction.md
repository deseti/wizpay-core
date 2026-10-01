---
title: "Introduction"
description: "Wallet-signed payments and verified settlement on Arc Mainnet."
---

# Introduction

WizPay provides a payment workspace at [app.wizpay.xyz](https://app.wizpay.xyz). Users connect an external wallet, review payment details, and sign transactions themselves. The backend prepares requests, records execution intent, and verifies on-chain results.

## Production Model

- Arc Mainnet uses chain ID `5042`.
- The connected wallet signs and submits transactions. WizPay does not hold user signing keys or custody funds.
- The frontend runs on Vercel. The NestJS backend, PostgreSQL, and Redis run in Docker on the production VPS.
- Feature availability is controlled by the backend's `GET /capabilities` response. A menu item or source-code implementation does not by itself mean a feature is enabled.

## Payment Workspace

The application provides Send, Payroll, Invoices, and a combined Swap & Bridge workspace. Assets are accessible from Home; Account is accessible from the wallet menu.

Payment actions are available only when the corresponding capability and route checks pass. Disabled actions must not be treated as supported payment routes.

| Workflow | Purpose |
| --- | --- |
| Send | Prepare a transfer, sign it in the connected wallet, and verify its receipt |
| Payroll | Plan recipient batches, execute them from the wallet, and track verified unit results |
| Invoices and payment links | Create a payment request and verify the payer's submitted transaction |
| Swap & Bridge | Use the enabled route after its capability, quote, and readiness checks pass |

## Scope

These docs describe the current external-wallet application and its core backend integration. Domain registration, ANS partner dashboards, hosted-wallet signing, standalone FX execution, liquidity execution, and APIs from separate repositories are outside this scope.

See [Core Concepts](/how-it-works) for the payment lifecycle and [API Reference](/api-overview) for implemented backend routes.
