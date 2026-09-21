---
title: "Nano WizPay Agent API"
description: "Use the production Nano WizPay Agent API for non-custodial swap and payroll preparation on Arc."
---

# Nano WizPay Agent API

**Agent Connect has been replaced by Nano WizPay Agent API.**

The old Agent Connect model is retired and deprecated. Email OTP onboarding, scoped session tokens, wallet profiles, the old faucet flow, payment intents, approve-intent, and execute-transfer flows are no longer the production agent API.

The production Nano WizPay Agent API is:

```text
https://api.wizpay.xyz
```

Local development for the separate `nano-wizpay` repo remains:

```text
http://localhost:3000
```

Do not use the local URL for production agents, integrations, or public documentation examples.

## Execution Model

Nano WizPay Agent API is non-custodial. It never stores private keys, never signs user transactions, never executes user funds, and never custodies user funds.

The API prepares routes and execution instructions. The agent, user wallet, frontend, SDK, raw calldata executor, or an external-wallet CLI executes the returned calldata or commands.

Free read-only endpoints:

- `GET /services`
- `GET /contracts/status`
- `POST /swap/quote`
- `POST /payroll/plan`

Paid prepare endpoints:

- `POST /swap/prepare`
- `POST /payroll/prepare`

Prepare endpoints use a 402-style service fee flow:

1. Call the prepare endpoint without payment.
2. The API returns `PAYMENT_REQUIRED` with the required fee details.
3. Pay the `0.003 USDC` service fee to the service fee collector.
4. Retry the same prepare request with:

```http
X-PAYMENT: <txHash>
```

After payment verification, the API returns calldata and external-wallet CLI command options for the caller to execute.

## Production Endpoints

```text
GET  https://api.wizpay.xyz/services
GET  https://api.wizpay.xyz/contracts/status
POST https://api.wizpay.xyz/swap/quote
POST https://api.wizpay.xyz/swap/prepare
POST https://api.wizpay.xyz/payroll/plan
POST https://api.wizpay.xyz/payroll/prepare
```

## Contracts

| Name | Address |
| --- | --- |
| WizPayPayrollMainnet | `0x77AC7Cb6507D404b5530fC03e3D39BAaEdE10C34` |
| WizPaySwapExecutorMainnet | `0x7A051F17B237750EF9D4E63fb75381B9F8755774` |
| USDC | `0x3600000000000000000000000000000000000000` |
| EURC | `0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1` |
| Service fee collector | `0x32F251fc36A1174901124589EAC2d4E391816F69` |

Service fee:

```text
0.003 USDC
```

## Curl Examples

### List Services

```bash
curl https://api.wizpay.xyz/services
```

### Check Contract Status

```bash
curl https://api.wizpay.xyz/contracts/status
```

### Request Swap Quote

```bash
curl -X POST https://api.wizpay.xyz/swap/quote \
  -H "Content-Type: application/json" \
  -d '{
    "tokenIn": "EURC",
    "tokenOut": "USDC",
    "amountIn": "0.01",
    "recipient": "0xa9914bca9123ba0079be8c968f632c0db6400fe7",
    "slippageBps": 100
  }'
```

`/swap/quote` is read-only. It does not create a transaction, collect a fee, sign anything, or move funds.

### Plan Payroll

```bash
curl -X POST https://api.wizpay.xyz/payroll/plan \
  -H "Content-Type: application/json" \
  -d '{
    "tokenIn": "USDC",
    "referenceId": "DOCS-PAYROLL-PLAN-001",
    "slippageBps": 100,
    "payouts": [
      {
        "recipient": "0x1111111111111111111111111111111111111111",
        "tokenOut": "USDC",
        "amountIn": "0.001"
      },
      {
        "recipient": "0x2222222222222222222222222222222222222222",
        "tokenOut": "EURC",
        "amountIn": "0.001"
      }
    ]
  }'
```

`/payroll/plan` is read-only. It returns a payroll plan for review before any paid prepare call.

### Prepare Swap Without Payment

```bash
curl -X POST https://api.wizpay.xyz/swap/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "tokenIn": "EURC",
    "tokenOut": "USDC",
    "amountIn": "0.01",
    "recipient": "0xa9914bca9123ba0079be8c968f632c0db6400fe7",
    "slippageBps": 100
  }'
```

Expected result before the service fee is paid:

```json
{
  "error": "PAYMENT_REQUIRED",
  "amount": "0.003",
  "currency": "USDC",
  "chain": "arc-mainnet",
  "payTo": "0x32F251fc36A1174901124589EAC2d4E391816F69"
}
```

After paying the service fee, retry with the payment transaction hash:

```bash
curl -X POST https://api.wizpay.xyz/swap/prepare \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: 0xServiceFeeTxHash" \
  -d '{
    "tokenIn": "EURC",
    "tokenOut": "USDC",
    "amountIn": "0.01",
    "recipient": "0xa9914bca9123ba0079be8c968f632c0db6400fe7",
    "slippageBps": 100
  }'
```

The paid response returns calldata and external-wallet CLI commands for the caller to execute. WizPay does not sign or submit the user's swap transaction.

### Prepare Payroll Without Payment

```bash
curl -X POST https://api.wizpay.xyz/payroll/prepare \
  -H "Content-Type: application/json" \
  -d '{
    "payer": "0xa9914bca9123ba0079be8c968f632c0db6400fe7",
    "tokenIn": "USDC",
    "referenceId": "DOCS-PAYROLL-PREPARE-001",
    "slippageBps": 100,
    "payouts": [
      {
        "recipient": "0x1111111111111111111111111111111111111111",
        "tokenOut": "USDC",
        "amountIn": "0.001"
      },
      {
        "recipient": "0x2222222222222222222222222222222222222222",
        "tokenOut": "EURC",
        "amountIn": "0.001"
      }
    ]
  }'
```

Expected result before the service fee is paid:

```json
{
  "error": "PAYMENT_REQUIRED",
  "amount": "0.003",
  "currency": "USDC",
  "chain": "arc-mainnet",
  "payTo": "0x32F251fc36A1174901124589EAC2d4E391816F69"
}
```

After paying the service fee, retry with the payment transaction hash:

```bash
curl -X POST https://api.wizpay.xyz/payroll/prepare \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: 0xServiceFeeTxHash" \
  -d '{
    "payer": "0xa9914bca9123ba0079be8c968f632c0db6400fe7",
    "tokenIn": "USDC",
    "referenceId": "DOCS-PAYROLL-PREPARE-001",
    "slippageBps": 100,
    "payouts": [
      {
        "recipient": "0x1111111111111111111111111111111111111111",
        "tokenOut": "USDC",
        "amountIn": "0.001"
      },
      {
        "recipient": "0x2222222222222222222222222222222222222222",
        "tokenOut": "EURC",
        "amountIn": "0.001"
      }
    ]
  }'
```

The paid response returns batch calldata and external-wallet CLI command options for the caller to execute. WizPay does not sign or submit payroll transactions.

## Payroll Execution Note

Payroll prepare responses include batch calldata for SDK, frontend, and raw calldata executors.

For CLI demos, prefer the `routeAndPay` fallback commands from the documented fallback command set. Overloaded array-based `batchRouteAndPay` functions may fail in some CLI environments, so demos should use the fallback command set when available.

## Safety Requirements for Agents

Agents integrating with Nano WizPay Agent API should:

- Treat read-only responses as planning data, not completed execution.
- Show the user the payment, route, token, recipient, and fee details before asking them to execute anything.
- Require the user's wallet or external-wallet CLI environment to sign and submit transactions.
- Never ask WizPay API to store, receive, or sign with private keys.
- Never treat an unpaid prepare response as executable.
- Never replace a missing official route with synthetic pricing or a legacy fallback.

## Production Proof

No Mainnet execution proof is recorded here. Mainnet receipts are reviewed through the authorized Mainnet explorer and backend reconciliation before any activation.

## Deprecated Agent Connect References

Agent Connect formerly used `https://agent.wizpay.xyz` and an onboarding/session model built around email OTP, scoped tokens, wallet profiles, faucet calls, payment intents, approvals, and execute-transfer calls.

That model is retired. New integrations should use `https://api.wizpay.xyz` and the Nano WizPay Agent API endpoints documented above.
