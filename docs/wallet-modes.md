---
title: "Wallet Modes"
description: "Signing model: external-wallet-only on Arc Mainnet."
---

# Wallet Modes

WizPay is external-wallet-only on Arc Mainnet. The connected external wallet holds the signing key and submits every on-chain write. The backend never holds signing keys, never signs on behalf of users, and never custodies funds.

## Mode Selection

`ExecutionRouterService` resolves the external-wallet execution path for Arc Mainnet. Any non-Mainnet selector is rejected before execution.

## External Wallet (Non-Custodial)

**Signing model:**
- The user connects an external wallet through the Reown connector.
- The user approves and signs each transaction in their own wallet.
- The backend prepares, validates, and reconciles; it does not sign.

**Flow:**
1. User connects their external wallet in the frontend.
2. Frontend submits the validated task payload to the backend.
3. Backend validates the route, prepares execution, and returns instructions.
4. User signs and submits the transaction in their wallet.
5. Backend reconciles the receipt and finalizes task state.

**Characteristics:**
- Client-side signing for every on-chain write.
- No backend signing authority.
- Arc Mainnet only.

## Isolation

The `ExecutionRouterService` is the **only** component aware of execution paths.

- Agents do not check wallet paths. They receive tasks through the router and execute.
- The orchestrator does not check wallet paths. It calls the execution router.
- Workers do not check wallet paths. They call the orchestrator.
