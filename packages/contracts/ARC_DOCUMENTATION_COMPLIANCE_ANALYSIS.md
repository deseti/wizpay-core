# Project Compliance Analysis Against ARC Documentation

## Scope of Analysis

This analysis compares the current project against the following documentation:

- https://docs.arc.network/
- https://docs.arc.network/arc/tutorials/transfer-usdc-or-eurc
- https://docs.arc.network/app-kit/swap

To ensure a thorough and non-superficial review, supporting pages from the ARC documentation were also cross-referenced, including connect-to-arc, system overview, contract addresses, and app kit installation/quickstart.

The assessment in this file is based on an audit of the source code, dependencies, configuration, and existing repo documentation. No end-to-end live flows were executed against Circle production/test credentials, so this verdict evaluates the **implementation compliance as visible in the repository**, not the operational success of secret environment variables unavailable in the workspace.

## Short Answer

No, this project is **not yet fully aligned** with the ARC documentation referenced above.

The most accurate conclusion is:

- **Sufficiently aligned at the ARC network/infrastructure level**: chain, RPC, explorer, primary tokens, and the assumption of USDC as gas are all correct.
- **Not fully aligned at the official ARC/Circle flow level**: the application's core runtime still uses a custom architecture — Privy smart wallets + WizPay/WizPay contracts + custom StableFXAdapter_V2.
- **Official Circle StableFX integration is only halfway complete**: the client and API routes already exist, but the main UI submission path still does not execute the Permit2 -> typedData signing -> FxEscrow settlement flow as documented.

Therefore, this project is more accurately described as:

> A custom application that is ARC-aware and partially ARC-compatible, but **not a complete implementation identical to** the official ARC transfer tutorial or ARC App Kit swap.

## Per-Document Summary

| Document | Status | Notes |
| --- | --- | --- |
| docs.arc.network (general) | Mostly compliant | Arc Testnet configuration, primary tokens, and USDC-as-gas assumption are in sync. |
| transfer-usdc-or-eurc | Not fully compliant | The official doc uses Circle Developer-Controlled Wallets; this repo uses Privy smart wallet + custom contracts. |
| app-kit/swap | Not fully compliant | The official doc uses App Kit/Swap Kit from Circle; this repo does not use those packages in its core runtime. |

## What Is Already Compliant with ARC

### 1. Arc Testnet Configuration Is Correct

On the frontend side, the ARC Testnet chain is correctly defined, including chain ID `5042002`, the ARC Testnet RPC, and ARC Testnet explorer. The project also treats USDC as the native gas token, consistent with ARC documentation.

Primary evidence:

- `frontend/lib/wagmi.ts`
- `frontend/app/providers.tsx`
- `.env.example`

### 2. Official Circle Token Addresses on ARC Are Used

This repo uses ARC token addresses that indeed appear in ARC documentation, specifically:

- USDC: `0x3600000000000000000000000000000000000000`
- EURC: `0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a`
- USYC also appears in the root configuration

Primary evidence:

- `frontend/constants/addresses.ts`
- `.env.example`
- `README.md`

### 3. Permit2 Address Is Correct

The Permit2 address used in the repo matches the standard address also referenced in Circle StableFX flows and related documentation.

Primary evidence:

- `frontend/constants/addresses.ts`
- `.env.example`

### 4. There Is a Real Foundation for Circle StableFX

This repo is not merely README documentation. The frontend already has a Circle StableFX client that accesses the official quote, trade, and trade status endpoints. Next.js API routes to proxy these requests also exist.

Primary evidence:

- `frontend/lib/circle.ts`
- `frontend/lib/stablefx.ts`
- `frontend/app/api/fx/quote/route.ts`
- `frontend/app/api/fx/execute/route.ts`
- `frontend/app/api/fx/status/[tradeId]/route.ts`

This means the team has moved toward the official Circle StableFX flow, but the implementation is not yet complete end-to-end.

## What Is Not Yet Aligned with ARC Documentation

### A. Not Aligned with the Official USDC/EURC Transfer Tutorial

### Expectations from the Official Document

The `transfer-usdc-or-eurc` ARC tutorial fundamentally directs implementation toward a Circle Developer-Controlled Wallets flow:

- Creating a wallet set via Circle
- Creating a wallet on Arc Testnet
- Checking Circle wallet balance
- Transferring using the Circle API/SDK
- Polling Circle transaction status

This is a **Circle-managed wallet** flow.

### Current Repo Implementation

This repo is not built around Circle Developer-Controlled Wallets. Instead, it uses:

- Privy auth and smart wallets on the frontend
- Transactions executed by the user through their own smart wallet
- Payments processed through the `WizPay`/`WizPay` contract
- Cross-stablecoin swaps performed through a custom engine `StableFXAdapter_V2` or planned Circle StableFX

Additionally, dependencies identical to the official Circle Wallets tutorial are not present in the main project packages. The frontend uses Privy, wagmi, viem, and permissionless — not the Circle Developer-Controlled Wallets SDK.

Primary evidence:

- `frontend/package.json`
- `backend/package.json`
- `frontend/app/providers.tsx`
- `frontend/hooks/wizpay/useBatchPayroll.ts`
- `contracts/WizPay.sol`
- `contracts/WizPay.sol`

### Verdict for Transfer Tutorial

**Not fully compliant.**

If the goal is "does this project execute the same flow as the official ARC/Circle transfer tutorial?", the answer is: **not yet**.

This repo chose a fundamentally different architecture: non-custodial smart-wallet + custom contracts, rather than a Circle-managed wallet flow.

### B. Not Aligned with the Official App Kit Swap

### Expectations from the Official Document

The `app-kit/swap` page directs implementation toward Circle App Kit / Swap Kit, typically with components such as:

- `@circle-fin/app-kit` or `@circle-fin/swap-kit`
- `@circle-fin/adapter-viem-v2`
- `kit.swap(...)` flow
- `KIT_KEY`
- `Arc_Testnet` chain string

### Current Repo Implementation

This repo does not show usage of the official App Kit/Swap Kit packages in the main frontend dependencies. Instead, the swap/payment flow runs through its own contracts and hooks.

Most importantly, the main UI submission path still uses `batchRouteAndPay` on the WizPay contract, not `kit.swap(...)`.

#### Evidence of Current Runtime Architecture

1. `frontend/hooks/wizpay/useWizPayContract.ts` still approves against `WIZPAY_ADDRESS`, not a Permit2/FxEscrow flow.
2. The same hook still estimates swap results via `getBatchEstimatedOutputs` from the contract, not via Circle quotes in the main UI.
3. That file also contains TODO comments explicitly stating that the full StableFX Permit2 flow is not yet complete, and that both modes currently use on-chain `batchRouteAndPay`.
4. `frontend/lib/fx-service.ts` does have `getQuote`, `executeFxTrade`, and `getFxTradeStatus` helpers, but source searches show these helpers are not used by the main hooks — they are only defined within the service file.

Primary evidence:

- `frontend/package.json`
- `frontend/hooks/wizpay/useWizPayContract.ts`
- `frontend/lib/fx-service.ts`
- `contracts/WizPay.sol`

### Verdict for App Kit Swap

**Not fully compliant.**

Conceptually, this repo is closer to:

- Custom payroll/payment orchestration
- Custom contract routing
- Optional Circle StableFX bridge

rather than the official App Kit swap implementation described in the docs.

### C. Official Circle StableFX Integration Is Not Yet Complete End-to-End

This is the most important section because at first glance the repo appears to have "already integrated Circle." After close examination, the actual status is **partial integration**.

### What Already Exists

- A Circle StableFX client genuinely pointing to the official quote/trade/status endpoints
- A mode switch between `legacy` and `stablefx`
- References to `FxEscrow` and `Permit2`
- Internal API routes for quote, execute, and status

### What Is Not Yet Complete

- The main UI path does not request a tradable Circle quote as the primary submission step
- Permit2 typed data signing is not connected to the main user flow
- Circle trade execution is not the primary settlement path when a user submits payroll
- Trade status polling is not part of the core transaction lifecycle
- Backend services named StableFX and Circle still contain mock/placeholder data

Primary evidence:

- `frontend/lib/circle.ts`
- `frontend/lib/fx-config.ts`
- `frontend/lib/fx-service.ts`
- `frontend/hooks/wizpay/useWizPayContract.ts`
- `backend/src/services/stablefx.service.ts`
- `backend/src/services/circle.service.ts`

### Practical Impact

This means that although the repo has prepared official Circle StableFX components, the **real execution path** used by users is not yet identical to the flow described in the official documentation.

### D. Inconsistent FxEscrow Addresses Within the Repo

This is an important gap as it involves the official settlement contract.

### Findings

- `frontend/constants/addresses.ts` uses `FX_ESCROW_ADDRESS = 0x867650F5eAe8df91445971f14d89fd84F0C9a9f8`
- Many root files, docs, env, and legacy scripts still use `0x1f91886C7028986aD885ffCee0e40b75C9cd5aC1`

Example evidence:

- `frontend/constants/addresses.ts`
- `.env.example`
- Various README and integration documents in root

### Why This Matters

If internal documentation, env files, and deployment/reference scripts use the old address while the frontend uses the new address, the claim "already aligned with ARC docs" cannot be considered clean. At minimum, there is a documentation and configuration synchronization issue.

### E. Backend Does Not Yet Represent Full ARC/Circle Production Integration

The backend has services named StableFX and Circle, but their contents are still mock/placeholder. This matters because if the project claims to be equivalent to the official flow, the backend or server-side integration layer must also be genuinely real, not stubs.

Key findings:

- `backend/src/services/stablefx.service.ts` still uses mock rates and mock trade lifecycle
- `backend/src/services/circle.service.ts` still returns mock wallet balances
- `backend/package.json` also does not show the official Circle Wallets SDK stack

From the backend perspective, the status remains **pre-production integration**, not a finalized full implementation.

## Actual Architecture Reading of This Project

After comparing all source code against the docs, the actual architecture of this repo looks like:

1. User logs in and transacts via Privy smart wallet.
2. Frontend prepares batch payroll/payment.
3. Frontend approves tokens for the `WizPay` contract.
4. Frontend calls `batchRouteAndPay(...)` on `WizPay`.
5. `WizPay` then forwards swaps/payouts through `fxEngine`.
6. In legacy mode, the engine is the custom `StableFXAdapter_V2`.
7. In stablefx mode, the repo has only laid the foundation for switching to Circle StableFX, but has not yet fully moved the main execution path to the official flow.

This is a valid architecture for a custom product, but it is **different** from the official ARC transfer tutorial and also different from the App Kit swap implementation that directly uses the official Circle toolkit.

## Final Conclusion

If the question is:

> "Is this project fully aligned with ARC documentation?"

The answer is:

> **Not yet.**

The most accurate one-sentence answer:

> This project is **sufficiently aligned with the ARC ecosystem at the chain and token level**, but **not yet fully aligned with the official ARC/Circle flow** for transfer tutorials or App Kit swap, because the core runtime is still based on a custom architecture and the official Circle StableFX integration is not yet complete end-to-end.

## Realistic Compliance Level

Assessed practically:

- **ARC network compatibility**: High
- **ARC transfer tutorial parity**: Low
- **ARC App Kit swap parity**: Low
- **Circle StableFX readiness**: Medium, but not finalized
- **Internal config/doc consistency**: Not yet clean

## Steps to Move Closer to Official ARC Documentation

If the goal is "truly fully or very close to the official documentation," then at minimum the following steps are needed:

1. First decide whether the product intends to follow the official `transfer-usdc-or-eurc` flow or deliberately keeps the custom Privy + smart wallet architecture.
2. If following the official transfer tutorial, add real Circle Developer-Controlled Wallets integration, not just Privy smart wallet.
3. If following `app-kit/swap`, install the official App Kit/Swap Kit packages and change the main swap flow to truly go through the official toolkit, not just the `batchRouteAndPay` contract.
4. Complete the full StableFX flow: quote -> typedData -> signature -> createTrade -> status polling -> settlement via FxEscrow.
5. Change the approval path to align with the Permit2/FxEscrow official flow when StableFX mode is active.
6. Synchronize all `FxEscrow` references in `.env.example`, README, scripts, and internal documentation to match the address currently used by ARC documentation.
7. Replace mock backend services with real integration, or if the backend is not used for this flow, remove claims that imply production integration is finalized.
8. Add clear frontend env documentation, since currently there is no `frontend/.env.example` as a configuration reference.

## Most Honest Verdict

This repo is **not a misdirected project**. Its foundation clearly understands ARC and the Circle stablecoin stack. However, if the assessment standard is "fully identical to the official ARC documentation provided," then the verdict is:

**Not yet fully aligned; still a mix between official implementation, custom implementation, and several parts that are still TODO/mock.**