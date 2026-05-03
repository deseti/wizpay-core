# Architecture

## Overview

WizPay is a monorepo with three applications and one shared package:

```
wizpay/
├── apps/
│   ├── backend/          # NestJS — orchestration, agents, adapters, queue
│   ├── frontend/         # Next.js — UI, wallet session, task polling
│   └── landing/          # Landing page
├── packages/
│   └── contracts/        # Smart contract ABIs and deployment artifacts
├── docker-compose.yml    # PostgreSQL, Redis, backend, frontend, nginx
└── nginx.conf            # Reverse proxy configuration
```

---

## Backend Modules

### Orchestrator (`src/orchestrator/`)
Central coordination layer. `OrchestratorService` exposes two methods:
- `handleTask()` — Called by HTTP controller. Creates task, enqueues to BullMQ.
- `executeTask()` — Called by workers only. Routes to agent via ExecutionRouter.

### Task (`src/task/`)
State machine and persistence layer. Services:
- `TaskService` — CRUD, status transitions, transaction tracking delegation
- `TaskUnitService` — Unit reporting, task status recomputation
- `TaskTransactionService` — On-chain tx record tracking
- `TaskLogService` — Append-only audit log

### Execution (`src/execution/`)
Wallet-mode routing:
- `ExecutionRouterService` — Checks `walletMode` (W3S vs PASSKEY), dispatches accordingly
- `PasskeyEngineService` — Handles bridge intents, EVM payroll, Solana unsigned intents, swap prep

### Agents (`src/agents/`)
Domain-specific execution logic:
- `AgentRouterService` — Switch dispatch to the correct agent by TaskType
- `PayrollAgent` — Batch transfers via Circle, enqueues poll jobs
- `BridgeAgent` — CCTP bridge via Circle Bridge Kit or external signer intent
- `SwapAgent` — Token swap execution
- `FxAgent` — USDC ↔ EURC trades, polls until settled
- `LiquidityAgent` — Add/remove liquidity

### Adapters (`src/adapters/`)
External service integrations:
- `CircleService` — Circle W3S API (wallets, transfers, FX trades)
- `CircleBridgeService` — Circle CCTP Bridge Kit
- `BlockchainService` — EVM chain interactions via viem
- `SolanaService` — Solana interactions via @solana/web3.js
- `DexService` — DEX swap preparation

### Queue (`src/queue/`)
BullMQ job management:
- `QueueService` — Enqueue-only (never processes jobs)
- Workers: `PayrollWorker`, `SwapWorker`, `BridgeWorker`, `TxPollWorker`
- Processors: `PayrollProcessor`, `SwapProcessor`, `BridgeProcessor`, `TxPollProcessor`
- `TransactionPollerService` — Polls Circle tx status, finalizes async tasks

### Treasury (`src/treasury/`)
- `TreasuryController` — `POST /treasury/init`, `GET /treasury/wallet`
- `TreasuryService` — Circle wallet set provisioning

### Wallet (`src/modules/wallet/`)
- `WalletController` — `POST /wallets/initialize`, `/sync`, `/ensure`
- `WalletService` — Per-user Circle wallet provisioning
- `W3sAuthService` — Circle W3S session management

### Integrations (`src/integrations/`)
- `TelegramService` — Task status notifications

---

## Component Flow

```
Frontend ──HTTP──▶ TaskController ──▶ OrchestratorService
                                           │
                              ┌────────────┼────────────┐
                              ▼            ▼            ▼
                        TaskService   QueueService   ExecutionRouter
                        (state mgmt)  (enqueue)      (wallet mode)
                                           │              │
                                     BullMQ Redis    ┌────┴─────┐
                                           │         ▼          ▼
                                      Workers    AgentRouter  PasskeyEngine
                                           │         │
                                      Processors     ▼
                                           │      Agents
                                           ▼         │
                                    executeTask()    ▼
                                                  Adapters
                                              (Circle, viem, Solana)
```

---

## Frontend Role

The frontend is a **UI-only layer**:
- Composes payment payloads from user input
- Calls backend HTTP endpoints to create tasks
- Polls `GET /tasks/:id` for progress
- Manages wallet sessions (W3S user token / passkey)
- In Passkey mode: signs and broadcasts transactions client-side

The frontend **never**: constructs raw blockchain transactions in W3S mode, calls Circle APIs directly, or manages task state.

---

## Data Flow

```
User Input → HTTP POST /tasks/* → TaskController → OrchestratorService
  → TaskService.createTask() → PostgreSQL
  → QueueService.enqueueTask() → Redis (BullMQ)
  → Worker → Processor → OrchestratorService.executeTask()
  → ExecutionRouter → Agent/Engine → Adapter → On-chain
  → TaskService.updateStatus() → PostgreSQL
  → Frontend polls GET /tasks/:id → renders result
```

---

## Infrastructure

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Backend | NestJS | Application server |
| Frontend | Next.js | UI |
| Database | PostgreSQL | Task persistence (Prisma ORM) |
| Queue | Redis | BullMQ job store |
| Reverse Proxy | Nginx | Routes `/api` → backend, `/` → frontend |
| Containerization | Docker Compose | Service orchestration |
