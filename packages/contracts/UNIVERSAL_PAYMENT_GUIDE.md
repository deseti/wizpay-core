# WizPay Universal Payment Guide

This guide previously documented a Hardhat-only runtime script. That script was removed as part of the Foundry migration.

## Current Approach

- Use `forge script` for deployment and scripted contract workflows.
- Use `cast send` for one-off live interactions against a deployed `WizPay` contract.
- Add any new operational automation under `script/` rather than reintroducing Hardhat.

## Example `cast send`

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

## Notes

- Same-token transfers can be sent directly to the token contract with `cast send` if no routing logic is required.
- Cross-token flows that depend on rate updates should be implemented as a dedicated Foundry script in `script/`.
- The canonical contract workflow is now documented in `README.md` and validated by `forge test`.
