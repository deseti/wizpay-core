---
title: "Execution Flow"
description: "From payment preparation to wallet submission and verified results."
---

# Execution Flow

## Send

1. Check the backend capabilities and validate the selected network and token route.
2. Acquire an execution intent containing the intended payment details.
3. Prepare wallet authorization for that intent.
4. Review and submit the transfer from the connected wallet.
5. Bind the transaction hash to the same intent.
6. Verify the direct Send receipt before showing completed settlement.

## Payroll

1. Submit the draft to `POST /tasks/payroll/init`.
2. The backend validates recipients, plans batches, and returns task units with intent identities.
3. Review the batch and any required approval in the wallet.
4. Submit each unit using the supported payment route.
5. Report the unit result to `POST /tasks/:taskId/units/:unitId/report`.
6. The backend verifies successful payroll reports and records unit and task progress.

Payroll initialization does not enqueue a backend-signed payment. Do not retry a completed unit or create a replacement payment for an unresolved hash.

## Invoices and Payment Links

1. The merchant authenticates with a wallet-signed challenge.
2. The merchant creates an invoice or payment link through the invoice API.
3. The payer opens the public checkout and reviews the requested payment.
4. The payer signs and submits the payment with their own wallet.
5. The checkout submits the transaction hash for invoice-specific verification.
6. The invoice is marked paid only after verification succeeds.

## Swap and Bridge

These workflows require their runtime capabilities and route-specific readiness checks.

Swap preparation and confirmation use the Mainnet swap API. The connected wallet executes the transaction; the legacy backend swap agent does not submit it.

Bridge uses the `/bridge/intents` lifecycle. Source and destination transactions, authorization, and attestation are distinct steps. Source-chain confirmation alone is not completed destination settlement.

## Interrupted Requests

Recover the existing intent and transaction evidence after a refresh or interrupted request. A timeout does not prove an on-chain failure and must not trigger an automatic duplicate payment.

Authentication-message signatures, token approvals, submitted hashes, and verified payment receipts represent different stages.
