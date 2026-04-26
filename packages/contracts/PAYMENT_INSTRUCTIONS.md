# WizPay Payment Instructions

The old Hardhat payment runner was removed during the Foundry migration.

## Recommended Live Interaction

Use `cast send` for direct on-chain calls:

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

## Environment

- `PRIVATE_KEY`: broadcaster key used by `cast`
- `ARC_TESTNET_RPC_URL`: ARC RPC endpoint
- `WIZPAY_ADDRESS`: deployed router address
- `TOKEN_IN` / `TOKEN_OUT`: ERC-20 token addresses
- `AMOUNT_IN` / `MIN_AMOUNT_OUT`: raw token amounts in smallest units
- `RECIPIENT`: destination wallet

## For Multi-Step Payment Automation

Implement a Foundry script under `script/` if you need rate refreshes, approvals, and routed payments bundled into one flow. `README.md` contains the supported Foundry deployment and testing commands.
