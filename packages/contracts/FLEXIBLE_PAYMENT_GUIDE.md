# WizPay Flexible Payment Guide

This document described a removed Hardhat execution script. The supported workflow is now Foundry-first.

## Use Instead

- `forge test` for regression coverage
- `forge script` for scripted multi-step workflows
- `cast send` for direct contract calls against a deployed router

## Suggested Next Step

If you need the old flexible-payment behavior back, implement it as `script/FlexiblePayment.s.sol` so it can:

1. read environment variables with `vm.env*`
2. broadcast through the configured RPC
3. call `WizPay.routeAndPay(...)` without any Hardhat runtime dependency

## Minimal Interaction Example

```bash
cast send "$WIZPAY_ADDRESS" \
  "routeAndPay(address,address,uint256,uint256,address)" \
  "$TOKEN_IN" \
  "$TOKEN_OUT" \
  "$AMOUNT_IN" \
  "$MIN_AMOUNT_OUT" \
  "$RECIPIENT" \
  --private-key "$PRIVATE_KEY" \
  --rpc-url "$ARC_TESTNET_RPC_URL"
```

The active project structure and deployment flow are documented in `README.md`.
