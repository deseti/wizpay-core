# Phase 6 Contract and Security Readiness

## Boundary and launch scope

This review prepares the smart-contract surface for the initial Arc Mainnet direct-USDC launch. It does not authorize deployment, broadcast, RPC access, or activation. Arc Mainnet chain ID is `5042`. The canonical Arc Mainnet USDC address, authorized Mainnet Safe, fee recipient, approved fee, deployment EOA, and deployment receipt are unavailable until they are supplied and authorized for Phase 8.

The call-path inventory establishes the following:

- Send uses canonical USDC `transfer` through the user-controlled wallet paths in `apps/frontend/app/send/page.tsx`, with backend W3S validation in `apps/backend/src/modules/wallet/w3s-auth.service.ts` and durable execution intents. No WizPay contract is called.
- Same-token Payroll approves canonical USDC to the configured WizPay address and calls `batchRouteAndPay` in `apps/frontend/hooks/wizpay/useWizPayContract.ts`. The backend validates calldata in `capabilities/capability.service.ts` and `w3s-auth.service.ts`, then reconciles the receipt in `task/payroll-receipt-verifier.service.ts`.
- Invoice uses canonical USDC `transfer` in `apps/frontend/hooks/useInvoicePayment.ts`; the backend verifies the exact token, payer, recipient, amount, chain, transaction value, and receipt through the invoice services.
- Payment Link uses the same direct token-transfer settlement policy and durable `PAYMENT_LINK_SETTLEMENT` intent family. It does not call a WizPay-owned contract.
- Token approval is an ERC-20 approval to `WizPayMainnetV2` only for same-token Payroll. Send, Invoice, and Payment Link do not need an approval to a WizPay contract.
- Fee collection exists only inside `WizPayMainnetV2` Payroll. Direct Send, Invoice, and Payment Link transfer the full configured amount without a WizPay contract fee.
- Pause, unpause, and emergency recovery exist only on `WizPayMainnetV2` and are controlled by its initial Safe owner.

### Solidity, script, manifest, ABI, and configuration classification

| Classification | Components                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Launch rationale                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REQUIRED`     | `src/WizPayMainnetV2.sol`; OpenZeppelin `Ownable`, `Pausable`, `ReentrancyGuard`, `IERC20`, and `SafeERC20`; `script/DeployWizPayMainnetV2.s.sol`; `scripts/mainnet-deployment-plan.mjs`; `deployments/arc-mainnet-wizpay-v2.input.example.json`; `deployments/arc-mainnet-wizpay-v2.json`; the `batchRouteAndPay`, `feeBps`, `DirectUsdcPayment`, `PayrollReferenceConsumed`, and compatibility `BatchPaymentRouted` ABI surface; backend Mainnet receipt reconciliation | Same-token USDC Payroll is the only launch flow that calls a WizPay-owned contract. The canonical USDC token contract is an explicit external constructor dependency. |
| `NOT_REQUIRED` | A WizPay-owned contract for direct Send, Invoice, or Payment Link; `src/IERC20.sol`; mocks in `src/mocks`; all Foundry test contracts                                                                                                                                                                                                                                                                                                                                     | Direct settlement calls canonical USDC itself. Local interfaces, mocks, and tests do not deploy to Mainnet.                                                           |
| `TESTNET_ONLY` | `src/WizPay.sol`; `script/Deploy.s.sol`; `deployments/arc-testnet-wizpay-v2.json`; `deployments/arc-testnet-wizpay-swap-executor-v2.json`; `deployments/arc-testnet-wizpay-swap-executor-v2.example.json`; the legacy `WIZPAY_ABI` FX estimation entries and Testnet history addresses                                                                                                                                                                                    | These artifacts contain legacy FX/Testnet behavior or recorded Arc Testnet resources. They are prohibited deployment inputs for Mainnet.                              |
| `DEFERRED_FX`  | `src/WizPaySwapExecutorV2.sol`, `src/StableFXAdapter_V2.sol`, `src/StableFXBridge.sol`, `src/IFXEngine.sol`, `src/IPermit2.sol`; `script/DeployWizPaySwapExecutorV2.s.sol`, `DeployStableFXAdapterV2.s.sol`, `ConfigureStableFXAdapterV2.s.sol`, and `DeployStableFXBridge.s.sol`; `abi/WizPaySwapExecutorV2.json`; every FX, RFQ, rate, swap, bridge, liquidity, Permit2, XyloNet, StableFX, Uniswap, EURC, and provider script under `scripts/`                         | Cross-token execution, liquidity, bridges, routers, and provider settlement are outside Phase 6 and must remain disabled for Mainnet.                                 |
| `DEPRECATED`   | `src/ans/ArcRegistry.sol`, `INamespaceRootRegistry.sol`, `NamespaceController.sol`, `NamespaceFactory.sol`, `NamespaceRegistrar.sol`, `PublicResolver.sol`, `RevenueVault.sol`, and `RootRegistry.sol`; `script/DeployANS.s.sol`                                                                                                                                                                                                                                          | ANS was removed from the active product boundary and is not part of the direct-USDC launch.                                                                           |

The Mainnet deployment input, manifest, and required contract do not reference `WizPaySwapExecutorV2`, XyloNet, StableFX, Uniswap, EURC, liquidity pools, bridges, or Testnet deployments. Runtime registries continue to mark Mainnet resources unavailable; Phase 6 does not activate them.

## Manual contract audit

The complete `WizPayMainnetV2` surface was reviewed for authorization, payer and recipient binding, canonical-token enforcement, arithmetic, fee behavior, replay protection, domain separation, batch ordering, validation, CEI, reentrancy, adversarial ERC-20 behavior, pause and recovery controls, residual balances, denial of service, bounded loops, events, receipt reconciliation, transaction ordering, compiler and dependencies, storage, upgradeability, and arbitrary execution exposure.

### F6-01

- ID: `F6-01`
- Severity: High
- Affected component: `WizPayMainnetV2` constructor and deployment boundary
- Attack or failure scenario: The previous constructor assigned ownership to `msg.sender`, leaving a deployer EOA as operational owner until a later transfer.
- Impact: A compromised or incorrect deployer could pause, alter fees, redirect future fees, or recover held USDC.
- Evidence: The Phase 6 baseline used `Ownable(msg.sender)` and accepted no owner constructor argument.
- Resolution: The constructor now requires `initialOwner`, requires that it already has deployed code, and passes it directly to OpenZeppelin `Ownable`. The offline planner and Foundry deployment script require an explicitly authorized, non-zero Safe distinct from the deployment EOA.
- Verification: Constructor and authorization tests assert the Safe is owner immediately and the deployer never owns the contract.
- Residual risk: Project governance must authenticate and authorize the real Safe address before Phase 8.

### F6-02

- ID: `F6-02`
- Severity: High
- Affected component: Payroll events and backend receipt reconciliation
- Attack or failure scenario: The baseline candidate emitted `PayrollReferenceConsumed`, while the backend expected only the legacy `BatchPaymentRouted` event and gross recipient transfers. Non-zero contract fees made valid Mainnet receipts unverifiable.
- Impact: Valid payrolls could fail durable completion; an insufficiently specific event model could not independently reconcile ordered gross, net, and fee values.
- Evidence: Baseline event and backend decoder signatures differed, and the legacy verifier expected recipient transfers equal to gross input amounts.
- Resolution: The contract emits ordered `DirectUsdcPayment`, domain-bound `PayrollReferenceConsumed`, and the compatibility summary. Mainnet verification binds chain, contract, payer, token, reference, ordered recipients, gross amounts, minimums, net amounts, fees, funding, outgoing conservation, and summary digest. Testnet retains its legacy verifier path unchanged.
- Verification: Backend tests accept exact Mainnet evidence and reject a mismatched net amount; Foundry event tests verify exact indexed and data fields.
- Residual risk: Phase 8 must verify deployed runtime bytecode and use the recorded ABI before activation.

### F6-03

- ID: `F6-03`
- Severity: High
- Affected component: ERC-20 funding and residual balances
- Attack or failure scenario: A fee-on-transfer or otherwise non-conserving canonical token could deliver less than the requested debit and consume unrelated residual contract USDC to complete recipients.
- Impact: Previously stranded funds could subsidize another payer, breaking payer-bound accounting.
- Evidence: The baseline checked only SafeERC20 call success, not the exact contract balance delta.
- Resolution: Execution records the pre-funding balance, requires an exact `totalAmount` increase, and requires the final balance to equal the pre-funding balance.
- Verification: Adversarial fee-on-transfer testing reverts without consuming the reference or residual balance. Conservation invariants keep contract residue at zero for clean-start successful executions.
- Residual risk: Canonical USDC itself remains an external trust dependency; its authorized Mainnet address must be confirmed before deployment.

### F6-04

- ID: `F6-04`
- Severity: Medium
- Affected component: Batch digest
- Attack or failure scenario: The baseline batch digest included token, recipients, and amounts but omitted chain, contract, and payer domains.
- Impact: Off-chain digest comparisons could collide across payers, contracts, or chains even though reference hashes were separately domain-bound.
- Evidence: Baseline `canonicalBatchDigest` encoded only canonical USDC, recipients, and amounts.
- Resolution: The digest now includes chain ID, contract, payer, canonical token, ordered recipients, and ordered amounts.
- Verification: Tests change each domain field, recipient order, and amount and observe a different digest.
- Residual risk: Off-chain systems must use this exact ABI encoding and not a textual reconstruction.

### F6-05

- ID: `F6-05`
- Severity: Medium
- Affected component: Fee governance
- Attack or failure scenario: An owner could change fee or fee recipient while execution remained active, changing settlement assumptions for pending transactions.
- Impact: A payer could receive a different bounded fee outcome than a stale UI preview.
- Evidence: Baseline fee setters were callable whenever the contract was unpaused.
- Resolution: Fee and fee-recipient changes require the contract to be paused. Fees remain explicit, integer basis points, and capped at 100 bps. A zero fee deterministically transfers no fee.
- Verification: Tests cover unauthorized calls, pause gating, the cap, zero collector rejection, zero-fee behavior, per-leg rounding, and exact conservation.
- Residual risk: The Safe can still set any fee up to the audited 1% cap and choose an authorized fee recipient; this is a documented governance trust assumption.

### F6-06

- ID: `F6-06`
- Severity: Medium
- Affected component: Emergency recovery
- Attack or failure scenario: The baseline accepted a token argument and allowed recovery while payment execution was active.
- Impact: A mistaken operation could target an unintended token interface or create avoidable governance/execution ordering risk.
- Evidence: Baseline `emergencyWithdraw(address token, uint256 amount)` was not pause-gated.
- Resolution: Recovery has no token parameter, is canonical-USDC-only, pause-gated, non-reentrant, owner-only, balance-bounded, and pays only the Safe owner.
- Verification: Tests cover active-state, unauthorized, zero, over-balance, and exact-balance recovery.
- Residual risk: The Safe can recover USDC genuinely held by the paused contract. Accidental deposits therefore remain under Safe trust.

### F6-07

- ID: `F6-07`
- Severity: Low
- Affected component: Recipient validation
- Attack or failure scenario: A payer could include itself as recipient, creating ambiguous fee-bearing self-payment accounting.
- Impact: Confusing reconciliation and unnecessary fees.
- Evidence: Baseline rejected only the zero recipient.
- Resolution: Payroll now rejects payer self-payment before token side effects.
- Verification: Negative recipient validation test.
- Residual risk: Duplicate non-payer recipients are allowed intentionally and remain ordered and exactly reconciled.

No unresolved Critical or High issue remains. No `tx.origin`, `delegatecall`, proxy, upgrade hook, arbitrary router, arbitrary token, arbitrary external call, or cross-token entry point exists. External interactions are limited to the immutable canonical USDC through `SafeERC20`; state is updated before interactions, guarded by `nonReentrant`, and transaction rollback restores the reference on failure. The only payment loop is capped at 50 entries. Arithmetic uses Solidity 0.8 checked operations. Duplicate references are payer-bound and contract/chain/token-domain-bound.

## Compiler, dependencies, and storage

- Source pragma: `^0.8.20`; pinned Foundry compiler: `0.8.24`.
- Optimizer: enabled, 200 runs; IR pipeline: enabled.
- OpenZeppelin Contracts: vendored version `5.6.1`.
- forge-std: vendored package version `1.16.0` as recorded by its local package metadata.
- Contract design is non-upgradeable. There is no proxy initializer, storage gap, delegatecall, fallback, receive function, or arbitrary calldata execution.
- Mutable storage is limited to inherited ownership/pause/reentrancy state, fee basis points, fee recipient, and consumed reference hashes. Canonical USDC is immutable.

## Safe ownership and deployment workflow

`DeployWizPayMainnetV2.s.sol` requires chain ID `5042`, Mainnet-namespaced environment values, an approved constructor digest, an approved Safe authorization marker, an approved fee authorization marker, non-zero inputs, a Safe different from the deployment EOA, and rejection of known Testnet resources. It constructs `WizPayMainnetV2(canonicalUsdc, safeOwner, feeRecipient, feeBps)` so no deploy-then-transfer window exists.

`mainnet-deployment-plan.mjs` is the deterministic offline boundary. It accepts only the exact versioned input schema, validates compiler settings, rejects placeholders and known Testnet values, computes the ABI constructor digest, creation bytecode hash, init-code hash, and a canonical plan digest. Identical input and artifact bytes produce identical output; any constructor change changes both relevant digests. The CLI writes a new output file with exclusive creation and will not overwrite an existing plan.

The committed input template intentionally contains `UNAVAILABLE` and `null` values and therefore fails validation until authorized values are supplied. The committed output manifest remains `status: unavailable`; all deployment inputs and result evidence are null, and verification status is `unavailable`. The validator will not accept `deployed` without complete constructor, digest, transaction hash, positive block number, deployed address, runtime bytecode hash, and verification-status evidence.

## Operational and residual risks

- The canonical Arc Mainnet USDC address and actual Safe authorization are still unavailable. This is expected in Phase 6 and must block Phase 8 deployment until supplied.
- Deployment and source verification have not occurred. No contract address, transaction, receipt, block, runtime bytecode hash, or verification result is claimed.
- The Safe is a privileged trust boundary for pause, unpause, bounded fee configuration, fee recipient configuration, and paused recovery of held USDC.
- Transaction replacement must retain identical calldata and durable intent binding. A changed reference, recipient, amount, minimum, token, payer, contract, or chain produces different evidence and must not reconcile as the original operation.
- Front-running cannot change payer identity because `msg.sender` funds execution. Pause or fee governance transactions may cause a pending payroll to revert; they cannot redirect its principal. Clients must refresh fee state before signing.
