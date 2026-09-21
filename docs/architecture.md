---
title: "System Architecture"
description: "Component topology, responsibilities, and trust boundaries."
---

# System Architecture

WizPay is a monorepo containing a NestJS backend, a Next.js frontend, and shared protocol configuration. The active configuration is strict Arc Mainnet-only and external-wallet-only: the connected external wallet signs and submits every on-chain write in the browser, while the backend validates, orchestrates, and reconciles without holding signing keys or custodying funds.

## Component Topology

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Frontend (Next.js)                        │
│  Composes payloads · Polls task status · Manages wallet sessions   │
│  Signs and submits every on-chain write in the browser             │
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
│  (state)     │ (enqueue)    │ (external-wallet dispatch)           │
├──────────────┴──────┬───────┴───────────────────────────────────────┤
│                     │ BullMQ (Redis)                                │
│    ┌────────────────▼─────────────────┐                            │
│    │ Workers (payroll/swap/tx_poll)   │                            │
│    └────────────────┬─────────────────┘                            │
│                     │                                              │
│    ┌────────────────▼─────────────────┐                            │
│    │ Agents                           │                            │
│    │ PayrollAgent · SwapAgent         │                            │
│    │ FxAgent · LiquidityAgent         │                            │
│    └────────────────┬─────────────────┘                            │
│                     │                                              │
│    ┌────────────────▼─────────────────┐                            │
│    │ Adapters                         │                            │
│    │ BlockchainSvc · DexService       │                            │
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
- Manages external wallet sessions (Reown connector)
- Signs and broadcasts transactions client-side through the connected wallet

#### Mobile Shell

The frontend adapts to mobile viewports through a dedicated shell layer:

- **Bottom Navigation** — 4-tab fixed bar (Home, Swap, Liquidity, Profile). Visible on mobile; hidden at the `md` breakpoint and above. Desktop navigation is rendered separately in the sidebar.
- **Profile / Account Center** — A dedicated `/profile` route (`ProfileHubPage`) containing wallet identity, wallet address display, and the PWA install prompt on eligible devices.

#### Progressive Web App (PWA)

WizPay ships a complete PWA surface for add-to-home-screen installability on mobile and desktop:

| Artifact | Path | Purpose |
|---|---|---|
| Web Manifest | `app/manifest.ts` → `/manifest.webmanifest` | App name, display mode (`standalone`), theme/background colors, icon declarations |
| Service Worker | `public/sw.js` | Satisfies browser install heuristic; pass-through fetch (no caching) |
| App Icons | `app/icon.tsx`, `app/apple-icon.tsx`, `app/api/pwa-icon/route.tsx` | Dynamically generated PNG icons at 192 × 192, 512 × 512, and maskable variants |
| PWA Runtime | `src/features/pwa/components/PwaRuntime.tsx` | Client component mounted at the root that registers the service worker and captures the `beforeinstallprompt` event |
| Install State Store | `src/features/pwa/install-state.ts` | Shared Zustand store tracking `nativePromptAvailable`, `manualInstallAvailable`, `isInstalled`, `isMobileDevice`, `platform` |

The install prompt shown in the Profile hub gates visibility on a real installability signal (`nativePromptAvailable || manualInstallAvailable`) in addition to the mobile/not-installed/not-dismissed checks, preventing the prompt from appearing on platforms where installation is not possible.

### Orchestrator

- `OrchestratorService.handleTask()` — HTTP entry point. Creates task, sets status to `assigned`, enqueues to BullMQ.
- `OrchestratorService.executeTask()` — Worker entry point. Idempotency guard → status to `in_progress` → route to agent → finalize.
- Unsupported task submissions fail closed before task creation.

### Task Module

| Service | Responsibility |
|---|---|
| `TaskService` | CRUD facade, status transitions, delegation to sub-services |
| `TaskUnitService` | Unit reporting, task status recomputation |
| `TaskTransactionService` | Transaction record CRUD, terminal-state aggregation |
| `TaskLogService` | Append-only audit log, duplicate step detection |
| `TaskMapperService` | Prisma model → domain object mapping |

### Execution Layer

- `ExecutionRouterService` — Resolves the external-wallet execution path for Arc Mainnet. Any non-Mainnet selector is rejected.
- Execution engines handle their remaining authorized task types. Unauthorized routes fail closed.

### Agents

Each agent implements the `TaskAgent` interface:

```typescript
interface TaskAgent {
  execute(task: TaskDetails): Promise<AgentExecutionResult>;
}
```

| Agent | Operation | Settlement |
|---|---|---|
| `PayrollAgent` | Batch same-token USDC transfers | Async (tx_poll) |
| `SwapAgent` | Token swap (disabled by default) | Sync |
| `FxAgent` | FX trade (disabled by default) | Sync |
| `LiquidityAgent` | Add/remove liquidity (disabled by default) | Sync |

### Adapters

| Adapter | Target | Protocol |
|---|---|---|
| `BlockchainService` | Arc Mainnet | viem |
| `DexService` | DEX protocols | Chain-agnostic swap prep (disabled by default) |

### Queue

| Queue | Worker | Concurrency | Purpose |
|---|---|---|---|
| `payroll` | `PayrollWorker` | 5 | Payroll batch execution |
| `swap` | `SwapWorker` | 1 | Swap, FX, Liquidity |
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
│  Agents — prepare execution without signing keys  │
├──────────────────────────────────────────────────┤
│ EXTERNAL (third-party)                           │
│  Arc Mainnet RPC — chain reads and submission     │
│  Connected wallet — user-signed execution         │
└──────────────────────────────────────────────────┘
```

- All user input crosses the trust boundary at `TaskController` and is validated before reaching the orchestrator.
- The backend has no signing authority over user wallets. The trust model is external-wallet-only: the backend prepares and validates, the connected wallet signs and submits.
- Bridge, swap, liquidity, and cross-token routes fail closed unless an authorized Mainnet route is configured and enabled.

## Infrastructure

| Component | Technology | Deployment |
|---|---|---|
| Backend | NestJS | Docker container |
| Frontend | Next.js | Docker container |
| Database | PostgreSQL | Docker container |
| Queue | Redis | Docker container |
| Reverse Proxy | Nginx | Routes `/api` → backend, `/` → frontend |
| Orchestration | Docker Compose | All services in `docker-compose.yml` |
