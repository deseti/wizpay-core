# App Wallet Direct XyloNet Execution

## Scope and status

This path is only for Circle W3S User-Controlled App Wallet swaps on Arc
Testnet. It does not replace or modify the existing External Wallet executor.
The feature uses the deployed `WizPaySwapExecutorV2`, verified through read-only
Arc calls and configured through the WizPay Safe.

Arc Testnet configuration:

- RPC: `https://rpc.testnet.arc.io`
- Chain ID: `5042002`
- Owner and immutable fee recipient:
  `0xAA557eb00063ad487BFe0304Bd04B4d45114b721`
- Protocol fee: 25 bps
- Executor: `0x7B5573759576AD3AD9F9E3b4425ad68FD2b525ed`
- XyloRouter: `0x73742278c31a76dBb0D2587d03ef92E6E2141023`

The legacy V1 executor remains configured only for the unchanged External
Wallet path.

## Fund and liquidity flow

```text
Circle W3S User-Controlled Wallet
  -> approve(WizPaySwapExecutorV2, exact amountIn)
  -> WizPaySwapExecutorV2.executeSwap(..., recipient=user wallet)
  -> allowlisted XyloRouter
  -> XyloNet liquidity pool
  -> output token delivered to the same User-Controlled Wallet
```

The executor pulls input from `msg.sender`; the backend never requests a
treasury deposit. The treasury wallet, developer-controlled wallet IDs,
developer signing, Circle Entity Secret, treasury payout, and treasury refund
services are not dependencies of the direct executor.

`WizPaySwapExecutorV2` supports EOA and smart contract account callers. It does
not use `tx.origin`, requires `recipient == msg.sender`, applies exact router
allowances and clears them after execution, rejects partial router spending,
and measures the actual output-token balance increase at the recipient.

## W3S lifecycle

The backend first validates the feature flag, chain, deployed V2 bytecode,
Safe ownership, immutable fee recipient, 25 bps fee, router allowlist, token
allowlist, authenticated Circle user, wallet ID, and wallet address. It then
creates two separate User-Controlled contract-execution challenges:

1. `tokenIn.approve(WizPaySwapExecutorV2, amountIn)`, unless the existing
   allowance already covers `amountIn`.
2. `WizPaySwapExecutorV2.executeSwap(router, tokenIn, tokenOut, amountIn,
   minAmountOut, userWallet, deadline)`.

Both challenge creation and all challenge/transaction lookups use the same
authenticated `X-User-Token`. The Circle Web SDK executes each challenge in
the browser. Callback success is accepted only with a documented `COMPLETE`
SDK status and a backend lookup showing the Circle challenge is completed.

Challenge IDs, transaction IDs, transaction hashes, lifecycle stage, failures,
and terminal outcomes are stored in `AppWalletXylonetOperation`. Polling is
bounded. On completion, the backend verifies the Arc receipt,
`WizPaySwapExecuted` fields, output recipient, output token, and minimum output.

## Feature flag

`APP_WALLET_XYLONET_USER_CONTROLLED_ENABLED=true` selects this direct path.
Disabled or incomplete configuration fails closed before operation creation. It never
falls back to SwapKit treasury execution or any developer-controlled wallet.

Required later-phase runtime configuration:

```dotenv
RPC_URL=https://rpc.testnet.arc.io
CHAIN_ID=5042002
APP_WALLET_XYLONET_USER_CONTROLLED_ENABLED=true
APP_XYLONET_EXECUTOR_ADDRESS=0x7B5573759576AD3AD9F9E3b4425ad68FD2b525ed
APP_XYLONET_ROUTER_ADDRESSES=0x73742278c31a76dBb0D2587d03ef92E6E2141023
APP_XYLONET_CHAIN_ID=5042002
APP_XYLONET_TOKEN_ADDRESSES=USDC=0x3600000000000000000000000000000000000000,EURC=0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
APP_XYLONET_DEADLINE_MAX_SECONDS=1200
WIZPAY_FEE_SAFE=0xAA557eb00063ad487BFe0304Bd04B4d45114b721
```

## Current deployment verification

Read-only Arc checks confirm deployed code, Safe ownership and fee recipient,
25 bps fee, unpaused state, and router/USDC/EURC allowlists. No deployment or
transaction is performed by application startup. A browser-authorized W3S test
swap is still required to establish complete live lifecycle acceptance.

Official references:

- Arc RPC endpoints: https://docs.arc.io/arc/references/rpc-endpoints
- Circle User-Controlled Wallets: https://developers.circle.com/wallets/user-controlled
- Circle contract-execution challenge: https://developers.circle.com/api-reference/wallets/user-controlled-wallets/create-user-transaction-contract-execution-challenge
- Circle Web SDK challenge execution: https://developers.circle.com/sdks/user-controlled/web-sdk
- Circle transaction states: https://developers.circle.com/wallets/asynchronous-states-and-statuses
