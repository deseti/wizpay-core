---
title: "External Wallet"
description: "Wallet connection, authentication, and transaction signing."
---

# External Wallet

WizPay uses connected external wallets on Arc Mainnet, chain ID `5042`. The user controls the signing keys and authorizes every on-chain transaction.

## Connection and Authentication

The frontend connects wallets through Reown. Connecting a wallet and authenticating an account are separate steps.

1. Request a wallet-authentication challenge.
2. Sign the returned message in the wallet.
3. Submit the challenge ID and signature for verification.
4. Use the issued session for account-scoped backend requests.

The authentication signature proves wallet ownership. It does not send funds or approve token spending.

## Payment Signing

The frontend prepares a supported payment request and presents it to the wallet. The user reviews its network, token, amount, recipient, and any allowance request before signing.

Token approvals and payment transactions have separate hashes and outcomes. Only verified payment settlement completes the corresponding payment operation.

## Backend Boundary

The backend stores operation state and verifies on-chain evidence. It does not hold private keys, sign user transactions, or provide hosted-wallet execution.

## Recovery

If a payment has already been submitted, recover its intent and hash. Do not automatically open another payment request after a timeout or page refresh.

Signing an authentication challenge does not authorize the backend to spend from the wallet.
