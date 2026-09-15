# Arc Mainnet WizPayMainnetV2 Manual Deployment Runbook

## Scope and authority boundary

This runbook prepares a separately authorized manual deployment of `WizPayMainnetV2` to Circle Arc Mainnet, expected chain ID `5042` (`0x13b2`). It does not authorize a deployment. Repository automation must never create, import, inspect, unlock, rename, or modify a Foundry keystore and must never read a private key or keystore password.

Arcscan is an independent third party. Its RPC and explorer must not be described as Circle-operated or authoritative. The committed resource manifest records `https://rpc.arc-scan.org` and `0x3600000000000000000000000000000000000000` as candidates only. A candidate can support read-only probing and estimation, but it cannot pass final preflight.

Native Arc gas uses 18-decimal native units. The separate ERC-20 USDC interface uses 6 decimals. Do not mix these units or assume the native and ERC-20 interfaces are interchangeable.

## Required authorization artifacts

Before final preflight, a reviewed change must add explicit committed authoritative-source records and promote every mandatory deployment resource from `candidate` or `unavailable` to `official`. The deployment input and generated plan must bind:

- deployer public address;
- constructor owner/Safe address;
- fee recipient and fee basis points;
- the exact audited 40-character Git commit;
- resource-manifest digest;
- expected deployment-plan digest;
- release identifier and authorization timestamp;
- the path and digest of a committed authorization-evidence record.

An environment string is configuration, not a cryptographic Safe approval. The authorization record must refer to independently reviewable Safe or signed-release evidence. Do not place signatures, passwords, private keys, or credentials in the repository or `.env`.

## 1. Preflight and public-address verification

1. Confirm the reviewed branch and audited commit, then require a clean or explicitly reviewed worktree.
2. Build with the pinned Foundry settings and run the ABI drift check.
3. Generate the plan into a new file; the planner refuses to overwrite an existing output.
4. Independently obtain the public deployer address from the founder. Compare it with the plan, the `--sender` value, and the address displayed by Foundry for the selected account.
5. Run the read-only two-endpoint preflight. Both independently configured official RPCs must agree.

Command shapes (placeholders only):

```bash
forge build
node scripts/sync-mainnet-abi.mjs --check
node scripts/mainnet-deployment-plan.mjs plan <AUTHORIZED_INPUT_JSON> <OFFICIAL_RESOURCE_MANIFEST_JSON> <NEW_PLAN_JSON>
node scripts/mainnet-preflight.mjs \
  --rpc <OFFICIAL_RPC_URL_A> \
  --rpc-secondary <OFFICIAL_RPC_URL_B> \
  --expected-chain-id 5042 \
  --resource-manifest <OFFICIAL_RESOURCE_MANIFEST_JSON> \
  --plan <AUTHORIZED_PLAN_JSON> \
  --deployer <DEPLOYER_ADDRESS> \
  --owner <SAFE_ADDRESS> \
  --fee-recipient <FEE_RECIPIENT_ADDRESS> \
  --fee-bps <AUTHORIZED_FEE_BPS>
```

The preflight is read-only. It checks chain progress and freshness, fee data, deployment estimation/simulation, USDC bytecode and ERC-20 reads, proxy/code identity when recorded, plan and source hashes, public addresses, pending nonce agreement, and a two-times conservative gas balance threshold. A nonzero exit code means abort.

## 2. External signing and funding boundary

This repository intentionally contains no Arc Mainnet signing, key-loading, funding, or broadcast path. Those activities require a separately reviewed procedure and explicit authorization outside this remediation. The Phase 8A script entry point always reverts, so it can be used only for deterministic read-only hash parity tests.

Public deployer identity and native-balance evidence may be reviewed through the two official RPCs. Do not send ERC-20 USDC for gas, and do not treat 6-decimal ERC-20 units as 18-decimal native gas units.

## 3. Read-only simulation boundary

The planner, preflight, and Solidity parity tests recompute the canonical plan values from readable inputs and a fresh artifact. They do not authorize deployment.

No deployment command is provided in this runbook. A future deployment procedure must be introduced by a separate audited change after official resources and genuine Safe authorization evidence exist.

## 4. Receipt waiting and post-deployment verification

Wait for the authorized confirmation/finality threshold, then run:

```bash
node scripts/mainnet-post-deployment-verify.mjs \
  --rpc <OFFICIAL_RPC_URL_A> \
  --rpc-secondary <OFFICIAL_RPC_URL_B> \
  --resource-manifest <OFFICIAL_RESOURCE_MANIFEST_JSON> \
  --plan <AUTHORIZED_PLAN_JSON> \
  --tx <DEPLOYMENT_TRANSACTION_HASH> \
  --address <EXPECTED_DEPLOYED_ADDRESS> \
  --confirmations <AUTHORIZED_CONFIRMATION_THRESHOLD>
```

The verifier checks the successful receipt, CREATE address, sender, init code, confirmations, runtime bytecode, owner, canonical USDC, fee collector, fee rate, pause state, source commit, plan digest, and resource-manifest reconciliation. Its deterministic JSON is a review artifact only. It never edits the authoritative deployment manifest.

After manual review, update the final deployment manifest in a separate explicit action, verify source using the chosen explorer or verification service without claiming it is Circle-operated, and repeat the read-only verifier. Because the constructor assigns the Safe directly, no owner transfer should be needed. If the deployed owner is not the authorized Safe, abort activation; do not attempt to repair an unauthorized deployment casually.

## 5. Canary activation

Deployment does not activate the application. Complete receipt verification, manifest review, backend/frontend configuration review, and a new authorization cycle before enabling direct-USDC capabilities. Initial scope is direct Send, same-token USDC Payroll, Invoice, Payment Link, receipt verification, and durable execution intents only. Uniswap, EURC/cross-token payroll, StableFX, XyloNet, CCTP, Gateway, and Bridge remain disabled.

Use a separately authorized bounded canary. Confirm the application-selected network is `arc-mainnet`, no Testnet value appears, and all backend guards agree before any money-moving use.

## Abort conditions

Abort immediately on any of the following:

- chain ID is not exactly `5042`;
- any mandatory resource is `candidate`, `unavailable`, or lacks a committed authoritative-source record;
- the two RPCs disagree, rate-limit beyond bounded retries, report a stale chain, or do not observe advancing blocks;
- canonical USDC code, proxy identity, name, symbol, decimals, or standard ERC-20 reads differ;
- deployer native balance is insufficient;
- the pending nonce differs between RPCs or from the value reviewed before manual confirmation;
- source commit, creation bytecode, runtime bytecode, constructor digest, resource digest, or plan digest differs;
- constructor estimation or simulation fails;
- the receipt reverts, sender differs, contract address is unexpected, or confirmations are insufficient;
- the Safe authorization is missing, revoked, ambiguous, or does not bind the exact plan;
- any unresolved placeholder, Testnet fallback, or disabled integration appears.

## Incident handling and recovery

Deployed immutable code cannot be rolled back. Recovery means pausing the contract where the authorized Safe can safely do so, withholding application activation, preserving receipts and logs, documenting the failed deployment, and preparing a corrected replacement under a new audited commit, resource manifest, plan digest, and authorization cycle. Never conceal a failed deployment by changing the expected address or manifest after the fact. Do not automatically rebroadcast an ambiguous transaction.
