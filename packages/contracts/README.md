# WizPay Contracts (Arc Mainnet-only)

Foundry workspace for WizPay settlement contracts on Arc Mainnet.

## Scope

- Arc Mainnet only. Expected chain ID `5042`.
- Initial launch scope is direct-USDC execution through `WizPayMainnetV2`
  (same-token USDC payroll). Cross-token execution, liquidity, bridges,
  routers, and provider settlement remain disabled.
- No retired-network deployment, provider RFQ, or custodial wallet flow is part
  of the active Mainnet configuration.

## Canonical references

- `ARC_MAINNET_DEPLOYMENT_RUNBOOK.md` — manual Mainnet deployment procedure.
  Deployment is manual-only; repository automation never signs, funds, or
  broadcasts.
- `deployments/arc-mainnet-resources.json` — resource manifest (candidate and
  unavailable states until official resources are authorized).
- `deployments/arc-mainnet-wizpay-v2.json` — deployment manifest (unavailable
  until a reviewed deployment result is recorded).
- `PHASE6_CONTRACT_SECURITY_READINESS.md` — Mainnet launch scope and contract
  readiness review.

Historical deployment records under `deployments/` are retained as read-only
history only. They are not imported by runtime code and are prohibited
deployment inputs for Mainnet.

## Commands

```bash
forge build
forge test
npm run test:mainnet-deployment
npm run validate:mainnet-manifest
```

`npm run deploy` is intentionally fail-closed. See
`ARC_MAINNET_DEPLOYMENT_RUNBOOK.md` for the authorized manual procedure.
