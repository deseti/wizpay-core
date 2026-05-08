---
title: "System Architecture"
description: "Component topology, responsibilities, and trust boundaries."
---

# System Architecture

WizPay is a monorepo containing a NestJS backend, a Next.js frontend, and shared contract artifacts. Validation, queuing, task state, and backend-signed execution live in the backend. The main exception is the external-wallet bridge path, where the browser signs and submits the bridge while the backend remains responsible for validation and audit logging.

## Component Topology

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Frontend (Next.js)                        │
│  Composes payloads · Polls task status · Manages wallet sessions   │
│  Executes external-wallet bridge flows in the browser              │
└────────────────────────────┬────────────────────────────────────────┘
                             │ HTTP
┌────────────────────────────▼────────────────────────────────────────┐
│                     TaskController (/tasks/*)                       │
├─────────────────────────────────────────────────────────────────────┤
│                       OrchestratorService                           │
│  handleTask() ─── creates task, enqueues to BullMQ                 │
│  executeTask() ── called by workers, routes to agent               │
├──────────────┬──────────────┬───────────────────────────────────────┤
│  TaskService │ QueueService │ ExecutionRouterService                │
│  (state)     │ (enqueue)    │ (W3S vs PASSKEY dispatch)            │
├──────────────┴──────┬───────┴───────────────────────────────────────┤
│                     │ BullMQ (Redis)                                │
│    ┌────────────────▼─────────────────┐                            │
│    │ Workers (payroll/swap/bridge/    │                            │
│    │          tx_poll)                │                            │
│    └────────────────┬─────────────────┘                            │
│                     │                                              │
│    ┌────────────────▼─────────────────┐                            │
│    │ Agents                           │                            │
│    │ PayrollAgent · BridgeAgent       │                            │
│    │ SwapAgent · FxAgent · Liquidity  │                            │
│    └────────────────┬─────────────────┘                            │
│                     │                                              │
│    ┌────────────────▼─────────────────┐                            │
│    │ Adapters                         │                            │
│    │ CircleService · BlockchainSvc    │                            │
│    │ SolanaService · DexService       │                            │
│    │ CircleBridgeService              │                            │
│    └──────────────────────────────────┘                            │
├─────────────────────────────────────────────────────────────────────┤
│                    PostgreSQL (Prisma ORM)                          │
│  Task · TaskUnit · TaskTransaction · TaskLog                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### Frontend (Next.js)

- Composes payment payloads from user input
- Calls backend HTTP endpoints to create tasks
- Polls `GET /tasks/:id` for progress and renders status
- Manages wallet sessions (W3S userToken / passkey)
- In PASSKEY mode: signs and broadcasts transactions client-side
- For external-wallet bridge routes: executes the CCTP/AppKit burn, attestation, and mint flow in the browser

In W3S mode, the frontend **never** constructs raw blockchain transactions or manages task state. The external-wallet bridge path is the explicit exception: it uses public Circle bridge APIs from the browser and only sends a best-effort audit task to the backend.

#### Mobile Shell

The frontend adapts to mobile viewports through a dedicated shell layer:

- **Bottom Navigation** — 4-tab fixed bar (Home, Swap, Liquidity, Profile). Visible on mobile; hidden at the `md` breakpoint and above. Desktop navigation is rendered separately in the sidebar.
- **Mobile Faucet Card** — A compact card on the home screen (mobile-only) that displays the user's wallet address with a one-tap copy action and a direct link to the testnet faucet. Hidden on desktop.
- **Profile / Account Center** — A dedicated `/profile` route (`ProfileHubPage`) containing: ANS identity management (claim `.arc` and `.wizpay` names, set custom identity, link X handle), wallet address display, and the PWA install prompt on eligible devices.

#### Progressive Web App (PWA)

WizPay ships a complete PWA surface for add-to-home-screen installability on mobile and desktop:

| Artifact | Path | Purpose |
|---|---|---|
| Web Manifest | `app/manifest.ts` → `/manifest.webmanifest` | App name, display mode (`standalone`), theme/background colors, icon declarations |
| Service Worker | `public/sw.js` | Satisfies browser install heuristic; pass-through fetch (no caching) to avoid Circle SDK interference |
| App Icons | `app/icon.tsx`, `app/apple-icon.tsx`, `app/api/pwa-icon/route.tsx` | Dynamically generated PNG icons at 192 × 192, 512 × 512, and maskable variants |
| PWA Runtime | `src/features/pwa/components/PwaRuntime.tsx` | Client component mounted at the root that registers the service worker and captures the `beforeinstallprompt` event |
| Install State Store | `src/features/pwa/install-state.ts` | Shared Zustand store tracking `nativePromptAvailable`, `manualInstallAvailable`, `isInstalled`, `isMobileDevice`, `platform` |

The install prompt shown in the Profile hub gates visibility on a real installability signal (`nativePromptAvailable || manualInstallAvailable`) in addition to the mobile/not-installed/not-dismissed checks, preventing the prompt from appearing on platforms where installation is not possible.

#### Circle Mobile Session Recovery

On mobile devices, Circle W3S SDK sessions can silently expire when the browser is backgrounded. The frontend implements a provider-owned recovery layer:

- `useMobileRecovery` — Listens to `visibilitychange`, `focus`, `pageshow`, and `online` browser events. On each trigger (throttled) it calls `rearmSdkForSession` to re-hydrate the SDK with the current auth token.
- `rearmSdkForSession` — Sets the current user token on the Circle SDK instance without a full re-initialisation.
- `ensureSessionReady` — Exposed on `CircleWalletContextValue`. Called by `useTransactionExecutor` and the bridge screen before every Circle-mode operation. If the session is expired, arms the SDK and refreshes wallets before proceeding.
- `withRecoveredSession` — Wrapper inside `useChallengeActions`. Catches recoverable Circle session errors (code `155706` and related invalid-device codes), calls `ensureSessionReady`, and retries the failed operation exactly once.

### Orchestrator

- `OrchestratorService.handleTask()` — HTTP entry point. Creates task, sets status to `assigned`, enqueues to BullMQ.
- `OrchestratorService.executeTask()` — Worker entry point. Idempotency guard → status to `in_progress` → route to agent → finalize.
- Bridge payload normalization and validation happen here.

### Task Module

| Service | Responsibility |
|---|---|
| `TaskService` | CRUD facade, status transitions, delegation to sub-services |
| `TaskUnitService` | Unit reporting, task status recomputation |
| `TaskTransactionService` | Transaction record CRUD, terminal-state aggregation |
| `TaskLogService` | Append-only audit log, duplicate step detection |
| `TaskMapperService` | Prisma model → domain object mapping |

### Execution Layer

- `ExecutionRouterService` — Reads `walletMode` from task payload. Routes to `AgentRouterService` (W3S) or `PasskeyEngineService` (PASSKEY).
- `PasskeyEngineService` — Handles bridge intents, EVM payroll via treasury key, Solana unsigned intents, swap preparation.

### Agents

Each agent implements the `TaskAgent` interface:

```typescript
interface TaskAgent {
  execute(task: TaskDetails): Promise<AgentExecutionResult>;
}
```

| Agent | Operation | Settlement |
|---|---|---|
| `PayrollAgent` | Batch ERC-20/SPL transfers via Circle | Async (tx_poll) |
| `BridgeAgent` | CCTP burn+mint via Circle Bridge Kit | Sync |
| `SwapAgent` | Token swap | Sync |
| `FxAgent` | USDC ↔ EURC trade via Circle, polls until settled | Sync |
| `LiquidityAgent` | Add/remove liquidity | Sync |

### Adapters

| Adapter | Target | Protocol |
|---|---|---|
| `CircleService` | Circle W3S API | REST (wallets, transfers, FX trades) |
| `CircleBridgeService` | Circle CCTP Bridge Kit | SDK |
| `BlockchainService` | EVM chains | viem (ARC-TESTNET, ETH-SEPOLIA) |
| `SolanaService` | Solana | @solana/web3.js (SOLANA-DEVNET) |
| `DexService` | DEX protocols | Chain-agnostic swap prep |

### Queue

| Queue | Worker | Concurrency | Purpose |
|---|---|---|---|
| `payroll` | `PayrollWorker` | 5 | Payroll batch execution |
| `swap` | `SwapWorker` | 1 | Swap, FX, Liquidity |
| `bridge` | `BridgeWorker` | 1 | CCTP bridge execution |
| `tx_poll` | `TxPollWorker` | 1 | Transaction status polling |

## Trust Boundaries

```
┌──────────────────────────────────────────────────┐
│ UNTRUSTED                                        │
│  Frontend (user input, wallet sessions)          │
├──────────────────────────────────────────────────┤
│ TRUSTED (backend perimeter)                      │
│  TaskController — validates via class-validator   │
│  OrchestratorService — enforces state machine     │
│  Agents — execute with backend credentials        │
├──────────────────────────────────────────────────┤
│ EXTERNAL (third-party)                           │
│  Circle API — wallet ops, transfers, bridges     │
│  EVM RPCs — transaction submission               │
│  Solana RPC — transaction submission             │
└──────────────────────────────────────────────────┘
```

- All user input crosses the trust boundary at `TaskController` and is validated before reaching the orchestrator.
- Backend signing keys (Circle entity secret, `BACKEND_PRIVATE_KEY`) never leave the backend process.
- In PASSKEY mode, the backend has no signing authority over the user's wallet. The trust model shifts — the backend produces unsigned intents, the client signs.
- In external-wallet bridge mode, the backend also has no signing authority. It validates the submitted bridge metadata, records the audit trail, and leaves the burn/mint execution to the connected browser wallet.

## Infrastructure

| Component | Technology | Deployment |
|---|---|---|
| Backend | NestJS | Docker container |
| Frontend | Next.js | Docker container |
| Database | PostgreSQL | Docker container |
| Queue | Redis | Docker container |
| Reverse Proxy | Nginx | Routes `/api` → backend, `/` → frontend |
| Orchestration | Docker Compose | All services in `docker-compose.yml` |
