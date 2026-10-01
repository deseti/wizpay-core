---
title: "Wallet Integration"
description: "Integrate with the current external-wallet application lifecycle."
---

# Wallet Integration

Integrations with WizPay Core use the same wallet-signed payment lifecycle as the application. They must respect runtime capabilities, intent identity, wallet ownership, and receipt verification.

## Integration Sequence

1. Resolve the configured backend origin and read `GET /capabilities`.
2. Authenticate account-scoped access using a wallet-signed challenge.
3. Prepare a supported request through its operation-specific API.
4. Keep the returned execution-intent identity and access key.
5. Let the user review, sign, and submit in their own wallet.
6. Report the transaction hash and verify the expected settlement.
7. Recover the original operation after an interrupted response instead of submitting a duplicate payment.

See [API Reference](/api-overview) for the Core backend routes.

## Integration Boundary

The Core backend does not accept private keys or sign transactions for callers. Planning responses, authentication signatures, allowance approvals, and submitted hashes must not be represented as completed payments.

A disabled capability or unavailable route must stop preparation or execution. Do not replace it with fabricated quotes or an unsupported fallback.

## Separate Services

APIs maintained in other repositories are outside this Core integration reference. This page does not define a paid preparation service, a service-fee collector, or an agent-hosted wallet.

Use each separate service's own verified documentation and deployment configuration rather than assuming its endpoints exist in the Core backend.
