# Research: Direct App Wallet Swap via Circle Wallets Adapter

## Date: 2026-05-17

## Summary

**Direct App Wallet Swap using `@circle-fin/adapter-circle-wallets` is NOT supported for user-controlled (App) wallets.** The adapter is designed exclusively for developer-controlled wallets and requires server-side `apiKey` + `entitySecret`. It cannot execute transactions on behalf of a user-controlled wallet without the user's PIN/passkey challenge flow.

The treasury-mediated flow remains the correct production path for App Wallet swaps.

---

## Official Documentation Sources

| Source | URL |
|--------|-----|
| Arc App Kit Swap overview | https://docs.arc.network/app-kit/swap |
| Arc App Kit Adapter setups | https://docs.arc.network/app-kit/tutorials/adapter-setups |
| Arc Swap quickstart | https://docs.arc.network/app-kit/quickstarts/swap-tokens-same-chain |
| Circle Wallets overview | https://developers.circle.com/wallets |
| Dev-Controlled Wallets | https://developers.circle.com/wallets/dev-controlled |
| User-Controlled Wallets | https://developers.circle.com/wallets/user-controlled |
| `@circle-fin/adapter-circle-wallets` (jsDelivr) | https://www.jsdelivr.com/package/npm/@circle-fin/adapter-circle-wallets |
| Circle Wallets Provider SDK docs | https://docs-w3s-node-sdk.circle.com/classes/providers_circle-wallets.Provider.html |

---

## Research Findings

### 1. `@circle-fin/adapter-circle-wallets` Constructor/API

From official SDK TypeDoc and existing repo usage:

```typescript
import { createCircleWalletsAdapter } from '@circle-fin/adapter-circle-wallets';

const adapter = createCircleWalletsAdapter({
  apiKey: string,       // Circle API key (server-side secret)
  entitySecret: string, // Circle entity secret (server-side secret)
});
```

The underlying `Provider` class constructor (from SDK TypeDoc):

```typescript
new Provider({
  apiKey: string,
  entitySecret: string,
  chainId: number,
  baseUrl?: string,
  fallbackTransport?: null | Transport,
  pollingInterval?: number,
  timeout?: number,
})
```

**Key observation:** There is NO parameter for `walletId`, `userId`, `userToken`, or any user-controlled wallet identifier. The adapter authenticates as the developer entity and operates on developer-controlled wallets only.

### 2. Developer-Controlled vs User-Controlled Wallets

From Circle official docs:

- **Developer-controlled wallets**: Server-side, automated, custodial. The developer's `entitySecret` signs transactions. No user interaction required. Used for treasury, payouts, automation.
- **User-controlled wallets**: User holds key shares via MPC. Transactions require user approval through PIN, passkey, or social auth challenge. The `@circle-fin/w3s-pw-web-sdk` handles the client-side challenge UI.

**WizPay App Wallets are user-controlled wallets.** They use:
- `@circle-fin/w3s-pw-web-sdk` for client-side challenge/PIN flow
- Server-side `W3sAuthService` for session management
- `NEXT_PUBLIC_CIRCLE_APP_ID` for the user-controlled wallet app

### 3. Arc App Kit Adapter Setups — Circle Wallets Tab

From the official Arc docs adapter-setups page, the Circle Wallets adapter is listed as:

> "circle-wallets for your existing Circle Wallets account"

The link points to https://developers.circle.com/wallets/dev-controlled — confirming it is for **developer-controlled** wallets only.

### 4. Can `kit.swap()` Execute Using a User's App Wallet?

**No.** The `kit.swap()` call requires an adapter that can sign and submit transactions. The Circle Wallets adapter signs using the developer's entity secret, which only has authority over developer-controlled wallets.

To execute a swap from a user-controlled wallet, you would need:
1. A user-controlled wallet adapter (does not exist in the App Kit adapter ecosystem)
2. OR the user to approve a challenge via the W3S SDK for each transaction the swap requires (approve + execute)

The existing swap flow for external wallets works because the user's browser wallet (MetaMask etc.) directly signs via `window.ethereum` / viem `WalletClient`. There is no equivalent "user-controlled Circle wallet adapter" that can be passed to `kit.swap()`.

### 5. What Would Be Required for Direct App Wallet Swap?

A hypothetical direct path would require:

1. **Frontend-initiated swap preparation** — Call `kit.estimate()` or the backend `/user-swap/prepare` to get the swap transaction payload
2. **User challenge for token approval** — Submit a `createContractExecutionTransaction` via Circle User-Controlled Wallets API, which returns a challenge
3. **User approves challenge** — User enters PIN/passkey via W3S SDK
4. **User challenge for swap execution** — Submit another `createContractExecutionTransaction` for the actual swap call
5. **User approves second challenge** — User enters PIN/passkey again
6. **Poll for transaction completion** — Wait for both transactions to confirm

**Problems with this approach:**
- Circle's User-Controlled Wallets API uses `createContractExecutionTransaction` which requires knowing the exact contract ABI, function, and args — but the swap execution uses Circle's internal adapter contract with proprietary execution parameters
- The swap adapter's `prepareAction('swap.execute', ...)` internally constructs a complex multi-instruction call that is not documented for manual submission via the User-Controlled Wallets API
- There is no official documentation showing how to submit a SwapKit-prepared transaction through the User-Controlled Wallets challenge flow
- The swap requires atomic approve+execute which would need two separate user challenges with timing constraints

### 6. Existing Backend Treasury Swap Already Uses the Correct Pattern

The current `AppWalletSwapService.executeTreasurySwapWithCircleWalletAdapter()` correctly uses `createCircleWalletsAdapter` with the treasury's developer-controlled wallet to execute swaps on behalf of the treasury. This is the documented and supported pattern.

---

## Conclusion

| Question | Answer |
|----------|--------|
| Does `@circle-fin/adapter-circle-wallets` support user-controlled wallets? | **No** — developer-controlled only |
| Can `kit.swap()` be called with a user's App Wallet? | **No** — no adapter exists for user-controlled wallets |
| Is there a documented challenge-based swap flow for user-controlled wallets? | **Not documented** |
| Can we build a direct swap by manually submitting swap transactions via User-Controlled Wallets API? | **Unknown/Not documented** — the swap execution parameters are proprietary to the adapter contract |
| Should we implement a direct App Wallet Swap prototype? | **No** — insufficient documentation to prove feasibility |

---

## Recommendation

**Keep the treasury-mediated flow as the production path for App Wallet swaps.**

The direct App Wallet Swap path is **blocked** due to:
1. `@circle-fin/adapter-circle-wallets` is developer-controlled only
2. No user-controlled wallet adapter exists for App Kit / SwapKit
3. No official documentation describes submitting SwapKit-prepared transactions through the User-Controlled Wallets challenge API
4. The swap execution uses proprietary adapter contract parameters that are not documented for manual construction

If Circle releases a user-controlled wallet adapter for App Kit in the future, this research should be revisited. Monitor:
- https://developers.circle.com/release-notes/wallets-2026
- `@circle-fin/adapter-circle-wallets` npm changelog
- Arc App Kit adapter-setups documentation

---

## Feature Flag

No implementation is warranted. The feature flag `APP_WALLET_DIRECT_SWAP_ENABLED=false` is documented here for future reference if the blocker is resolved.

---

## Appendix: Existing Architecture Reference

### Current Treasury-Mediated Flow (Working)
```
User App Wallet → deposit tokenIn to treasury (challenge) →
Backend confirms deposit on-chain →
Treasury executes swap via createCircleWalletsAdapter (developer-controlled) →
Treasury pays tokenOut to user App Wallet (developer-controlled transfer)
```

### Hypothetical Direct Flow (BLOCKED)
```
User App Wallet → kit.swap() with ??? adapter →
??? challenge flow for approve + execute →
Direct on-chain swap from user wallet
```

The "???" represents the undocumented/unsupported gap.
