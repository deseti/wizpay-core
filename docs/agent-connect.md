---
title: "Agent Connect"
description: "Connect AI agents to WizPay payments, wallets, balances, approvals, and Arc stablecoin transfers."
---

# Agent Connect

Agent Connect is the WizPay interface for AI agents. It lets ChatGPT Actions, Claude, MCP clients, Telegram or WhatsApp bots, and custom automation tools connect to a user wallet, read balances, create approval-gated payment intents, and execute Arc testnet stablecoin transfers.

The public agent endpoint is:

```text
https://agent.wizpay.xyz
```

The OpenAPI schema for AI tools is:

```text
https://agent.wizpay.xyz/openapi.json
```

Use this schema when importing WizPay into ChatGPT Actions or another OpenAPI-compatible agent runtime.

## What Agent Connect Supports

Agent Connect currently supports:

- Health checks for the public API
- Email OTP onboarding for a user wallet session
- Scoped token issuance for agent calls
- Wallet profile lookup
- ARC-TESTNET balance checks
- EURC faucet requests on ARC-TESTNET
- Payment intent creation
- User approval for payment intents
- Payment execution through Circle Agent Wallet CLI

Supported chain:

```text
ARC-TESTNET
```

Supported tokens:

```text
USDC
EURC
```

Swap execution is not exposed through the current Agent Connect tools yet. Swap UX may exist elsewhere in the WizPay product, but external AI agents should treat swap as unsupported unless a dedicated Agent Connect swap endpoint is added.

## ChatGPT Actions Setup

In a custom GPT, add WizPay as an Action by importing the OpenAPI schema URL:

```text
https://agent.wizpay.xyz/openapi.json
```

Recommended setup:

- Authentication: None
- Schema source: Import from URL
- Privacy policy / terms: use the public WizPay links configured for the GPT listing

Authentication is handled by the `scopedToken` field or the secure Agent Connect cookie. The OpenAPI schema intentionally avoids global bearer auth so ChatGPT Actions can call public onboarding tools and then pass the scoped token inside request bodies or query parameters.

## User Flow

A typical AI-agent flow is:

1. Run `getHealth` to verify the API is online.
2. Start an Agent Connect session.
3. Ask the user for their email.
4. Request an email OTP.
5. Ask the user for the OTP.
6. Complete OTP verification.
7. Issue or receive a scoped token.
8. Check wallet profile and balances.
9. Create a payment intent.
10. Ask the user to approve the intent.
11. Execute the approved intent.
12. Return the transaction status or transaction hash when available.

The user experience should hide internal session IDs, API paths, and tokens from non-technical users whenever possible. Agents should ask only for the information required to proceed, such as email, OTP, payment amount, token, recipient, and final approval.

## Core Operations

### Health Check

Use health checks before running payment tools.

```http
GET /v1/health
```

Expected response:

```json
{
  "ok": true,
  "service": "wizpay-api",
  "domain": "agent.wizpay.xyz",
  "version": "v1"
}
```

### Start Session

```http
POST /v1/agent-connect/start
```

Example body:

```json
{
  "source": "chatgpt",
  "externalUserId": "chatgpt-user"
}
```

The response returns a session in `pending` or onboarding state.

### Request Email OTP

```http
POST /v1/agent-connect/{sessionId}/email
```

Example body:

```json
{
  "email": "user@example.com"
}
```

### Complete OTP

```http
POST /v1/agent-connect/{sessionId}/otp
```

Example body:

```json
{
  "otp": "123456"
}
```

After OTP verification, the session can bind to a Circle Agent Wallet profile and wallet address.

### Issue Scoped Token

```http
POST /v1/agent-connect/{sessionId}/token
```

The scoped token is used for later agent calls. Treat it as sensitive. Do not display it in public chats or logs.

### Check Connected Account

```http
GET /v1/agent-connect/me?scopedToken=...
```

Use this to confirm wallet connection and session status.

### Check Balances

```http
GET /v1/agent-connect/balances?scopedToken=...
```

Returns balances for the connected ARC-TESTNET wallet.

### Claim Faucet

```http
POST /v1/agent-connect/faucet
```

Example body:

```json
{
  "token": "EURC",
  "scopedToken": "wzac_test_..."
}
```

### Create Payment Intent

```http
POST /v1/agent-connect/intents
```

Example body:

```json
{
  "intent": "send_payment",
  "amount": "9",
  "token": "USDC",
  "chain": "ARC-TESTNET",
  "recipient": "0x8b9900ce7db1d89d8439995cfc526b9b839f4605",
  "memo": "Test payment",
  "scopedToken": "wzac_test_..."
}
```

The intent is created as `pending_approval`. The agent must ask the user for explicit approval before executing it.

### Approve Payment Intent

```http
POST /v1/agent-connect/intents/{intentId}/approve
```

Example body:

```json
{
  "approvalNote": "User approved payment in chat",
  "scopedToken": "wzac_test_..."
}
```

The approved intent can then be executed.

### Execute Payment Intent

```http
POST /v1/agent-connect/intents/{intentId}/execute
```

Example body:

```json
{
  "scopedToken": "wzac_test_..."
}
```

For a no-broadcast safety check, set `estimate` to `true`:

```json
{
  "estimate": true,
  "scopedToken": "wzac_test_..."
}
```

An estimated execution keeps the intent available for final execution later. A real execution submits the transfer through Circle Agent Wallet CLI.

## Approval and Safety Model

Agent Connect uses an approval-gated payment flow:

- Creating an intent does not send funds.
- Approval records the user's authorization.
- Execution is separate from approval.
- Execution requires the intent to be approved.
- Scoped tokens are tied to a connected Agent Connect session.

Agents should clearly summarize payment details before approval:

- Amount
- Token
- Chain
- Recipient
- Memo or purpose
- Whether the call is estimate-only or real execution

## Security Notes

- Never expose `scopedToken` in public docs, screenshots, or shared chat logs.
- Treat session IDs as internal implementation details for end users.
- Always ask for explicit user approval before executing a payment.
- Use `estimate: true` when testing execution flow without broadcasting.
- Keep production and testnet flows clearly separated.

## Current Limitations

- ARC-TESTNET is the supported agent chain.
- USDC and EURC are the supported agent tokens.
- Swap is not supported through Agent Connect yet.
- Batch payroll and advanced frontend-only flows are not fully exposed as AI-agent tools yet.
- Agent Connect is optimized for single-user wallet onboarding and approval-gated payments.

## Troubleshooting

### ChatGPT says the API schema is invalid

Re-import the schema from:

```text
https://agent.wizpay.xyz/openapi.json
```

If the GPT editor says there is a duplicate domain, remove the old Action using `agent.wizpay.xyz` before importing the new one.

### Health check fails in ChatGPT but works in a browser

Click Update in the GPT editor and make sure there are no pending schema changes. ChatGPT may keep using an older Action schema until the GPT is updated.

### Payment execution returns a Circle error

Confirm that:

- The intent status is `approved`.
- The scoped token belongs to the same session that created the intent.
- The token is `USDC` or `EURC`.
- The chain is `ARC-TESTNET`.
- The recipient is a valid EVM address.
- Use `estimate: true` first to verify Circle accepts the transfer request without broadcasting.
