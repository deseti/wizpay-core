---
title: "Core Concepts"
description: "Intent, wallet authorization, payment verification, and recovery."
---

# Core Concepts

A payment is a sequence of recorded intent, wallet authorization, transaction submission, and verification. Preparing a request does not transfer funds.

## Execution Intent

An `ExecutionIntent` binds the operation to its network, source wallet, tokens, amount, recipient or batch digest, and external reference. Logical keys and request fingerprints identify the operation across retries.

An intent can wait for a wallet signature, store a submitted transaction hash, enter verification, and complete after the expected receipt has been verified.

## Wallet Authorization

The user reviews the payment and any required token approval in their connected wallet. An authentication-message signature proves wallet ownership; it does not send a payment.

A token approval changes spending allowance. It is separate from the payment transaction and must not be displayed as successful payment settlement.

## Payroll Batches

Payroll preparation validates recipients and returns task units for the wallet to execute. A unit includes its batch reference and execution-intent identity.

Planning batches does not guarantee that the entire payroll is one atomic transaction. Multiple units can complete independently. Review each unit's result before retrying an unresolved payroll.

## Verification

The application reports a transaction hash to the appropriate backend verifier. The verifier checks the transaction against the expected operation. A client-reported hash or success message alone is not proof of settlement.

Send, payroll, invoice payments, swaps, and bridge steps use their own verification paths. They do not all pass through one generic task queue.

## Recovery

If a transaction was submitted but the application lost the response, recover the existing intent and known hash. Do not create a new payment merely because a request timed out or a page was refreshed.

A pending receipt or unavailable RPC does not prove that funds were not transferred. Preserve the original operation identity until its outcome is resolved.
