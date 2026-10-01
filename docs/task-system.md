---
title: "Task and Intent Tracking"
description: "Durable payment identities, payroll units, and verification states."
---

# Task and Intent Tracking

## ExecutionIntent

An execution intent records the network, operation, source wallet, token pair, amount, recipient or batch digest, and external reference.

Its `logicalKey`, `requestFingerprint`, and `idempotencyKey` identify the operation. A transaction hash binds submitted chain evidence to that intent. Lease ownership and expiry coordinate wallet preparation and recovery.

| State group | Meaning |
| --- | --- |
| `CREATED` | Intent recorded; no completed payment |
| `AWAITING_WALLET_SIGNATURE` | Wallet submission outcome still needs to be resolved |
| `SUBMITTED`, `VERIFYING` | Transaction evidence is recorded or being checked |
| `COMPLETED` | The expected receipt has passed verification |
| Retryable/final failure, expired, cancelled | Distinct outcomes governed by the intent state machine |

`FAILED_RETRYABLE` is not permission to create a duplicate transfer. Existing submission evidence must be reconciled.

## Task and TaskUnit

Payroll preparation produces a task and one or more batch units. Each unit carries its execution-intent identity and reference.

Task states include `created`, `assigned`, `in_progress`, `review`, `approved`, `executed`, `partial`, and `failed`. Not every workflow passes through every state.

A payroll unit begins as `PENDING` and can be reported as `SUCCESS` or `FAILED`. The unit-reporting path updates stored results and task counters in a database transaction. Successful payroll reports are receipt-verified before recording success.

In the unit-based payroll path, failed units lead to `review`; all successful units lead to `executed`. Do not assume the legacy transaction-poller aggregation describes this path.

## Logs and Activity

`TaskLog` stores task events and context. `Activity` provides account-scoped history across supported workflows. Logs and activity records should distinguish preparation, submission, and verification.

Invoice payments and bridge transactions also have their own durable state. They are not interchangeable with payroll units.

## Recovery Rules

- Keep the existing intent identity when retrying an HTTP request.
- Reconcile a known hash rather than asking the wallet to submit again.
- Do not treat a lease expiry or polling timeout as proof that a transfer failed.
- Respect terminal states and immutable request fields.
- Use the operation-specific verifier; direct Send verification does not verify a payroll batch.

BullMQ retry settings are infrastructure behavior, not a guarantee of exactly-once payment execution.
