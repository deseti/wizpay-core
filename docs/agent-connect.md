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

The API prepares routes and execution instructions. The agent, user wallet, frontend, SDK, raw calldata executor, or Circle CLI executes the returned calldata or commands.

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

After payment verification, the API returns calldata and Circle CLI command options for the caller to execute.

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
| WizPaySwapExecutor | `0x17685466759f9Cde06f0DCbB5464164ABe541eFA` |
| XyloRouter | `0x73742278c31a76dBb0D2587d03ef92E6E2141023` |
| WizPay Payroll Router | `0x87ACE45582f45cC81AC1E627E875AE84cbd75946` |
| USDC | `0x3600000000000000000000000000000000000000` |
| EURC | `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a` |
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
  "chain": "arc-testnet",
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

The paid response returns calldata and Circle CLI commands for the caller to execute. WizPay does not sign or submit the user's swap transaction.

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
  "chain": "arc-testnet",
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

The paid response returns batch calldata and Circle CLI command options for the caller to execute. WizPay does not sign or submit payroll transactions.

## Payroll Execution Note

Payroll prepare responses include batch calldata for SDK, frontend, and raw calldata executors.

For Circle CLI demos, prefer the `routeAndPay` fallback commands from `circleCliFallback.commands`. Circle CLI may fail with overloaded array-based `batchRouteAndPay` functions, so demos should use the fallback command set when available.

## Safety Requirements for Agents

Agents integrating with Nano WizPay Agent API should:

- Treat read-only responses as planning data, not completed execution.
- Show the user the payment, route, token, recipient, and fee details before asking them to execute anything.
- Require the user's wallet or Circle CLI environment to sign and submit transactions.
- Never ask WizPay API to store, receive, or sign with private keys.
- Never treat an unpaid prepare response as executable.
- Never replace a missing official route with synthetic pricing or a legacy fallback.

## Production Proof

Latest verified Arc testnet transactions:

| Flow | Transaction |
| --- | --- |
| Swap service fee | [0xfc6355aebbb1622661202b3aa8955d863ca81e197d3f0e7f7fcf1fbec0d27b12](https://testnet.arcscan.app/tx/0xfc6355aebbb1622661202b3aa8955d863ca81e197d3f0e7f7fcf1fbec0d27b12) |
| Swap approve | [0xd2c0f46016eedb9603488cd6126420b53bf6ad9660e6262462cd7d4d13a43c11](https://testnet.arcscan.app/tx/0xd2c0f46016eedb9603488cd6126420b53bf6ad9660e6262462cd7d4d13a43c11) |
| Swap executeSwap | [0x1a8df7e5ef4fc04b4a859e784067ce470886498a1673882af60be97d506ac9f8](https://testnet.arcscan.app/tx/0x1a8df7e5ef4fc04b4a859e784067ce470886498a1673882af60be97d506ac9f8) |
| Payroll service fee | [0xab1b9b62b8cbfc43c3a91fcd8571e75273128fef56ed46c05176d1ba073327ac](https://testnet.arcscan.app/tx/0xab1b9b62b8cbfc43c3a91fcd8571e75273128fef56ed46c05176d1ba073327ac) |
| Payroll approve | [0xd6b8739f6980aff40cd5ee1bf8343e7ecc3598ed9bcd991c85234b2af61a23ef](https://testnet.arcscan.app/tx/0xd6b8739f6980aff40cd5ee1bf8343e7ecc3598ed9bcd991c85234b2af61a23ef) |
| Payroll payout 1 | [0x1cc0c8e5173cc9782d255d953594e136c58337b2ca437f6890bfe22782fe14d6](https://testnet.arcscan.app/tx/0x1cc0c8e5173cc9782d255d953594e136c58337b2ca437f6890bfe22782fe14d6) |
| Payroll payout 2 | [0x15aa1dcced9720df77219174c130229162882d4e94abf3d0f4204558dc869560](https://testnet.arcscan.app/tx/0x15aa1dcced9720df77219174c130229162882d4e94abf3d0f4204558dc869560) |
| Payroll payout 3 | [0xa311ec6a9da90ff167d93b7f3fac995ed8817e881e41e885ff787d6b17bc53b1](https://testnet.arcscan.app/tx/0xa311ec6a9da90ff167d93b7f3fac995ed8817e881e41e885ff787d6b17bc53b1) |

## Deprecated Agent Connect References

Agent Connect formerly used `https://agent.wizpay.xyz` and an onboarding/session model built around email OTP, scoped tokens, wallet profiles, faucet calls, payment intents, approvals, and execute-transfer calls.

That model is retired. New integrations should use `https://api.wizpay.xyz` and the Nano WizPay Agent API endpoints documented above.
