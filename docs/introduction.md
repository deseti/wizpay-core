# WizPay — Introduction

## What WizPay Is

WizPay is an on-chain payment execution system built for programmatic, multi-recipient, multi-chain settlement. It accepts batches of payment instructions (payroll, swaps, bridges, FX conversions) and executes them through a unified orchestration layer backed by a task state machine, BullMQ job queues, and chain-specific adapters.

The backend is a NestJS monolith. The frontend is a Next.js application that acts purely as a UI layer — it never constructs or signs transactions directly in W3S mode. In Passkey mode, client-side signing is required for certain operations where the backend cannot access the user's key material.

## Core Idea

**Batch → Execute Once → Atomic Settlement**

WizPay's fundamental design pattern:

1. **Batch** — The user composes a set of payment instructions (recipients, amounts, tokens, chains). The frontend collects these into a single payload.
2. **Execute Once** — The backend creates a single `Task` record, splits it into `TaskUnit` records (one per batch or step), and enqueues the task to a BullMQ queue. A single worker picks it up.
3. **Atomic / Controlled-Partial Settlement** — The orchestrator routes the task to the appropriate agent (Payroll, Swap, Bridge, FX, Liquidity). Each agent handles on-chain execution. For synchronous tasks (swap, bridge, FX), the task is marked `executed` or `failed` atomically. For asynchronous tasks (payroll), individual transaction results are polled and aggregated — the task may resolve as `executed` (all succeeded), `partial` (some failed), or `failed`.

## Why WizPay Exists

### The Problem

Executing on-chain payments one at a time has compounding costs:

- **Gas inefficiency** — Each transaction pays a base gas cost. N separate transfers cost ~N× the gas of a batched approach.
- **Operational overhead** — Manual payment flows require a human to initiate, confirm, and monitor each transaction individually.
- **No atomicity** — If transaction 47 of 100 fails, there is no built-in mechanism to track which payments succeeded and which need retry.
- **Multi-chain complexity** — Organizations paying across EVM chains and Solana need different signing flows, RPC endpoints, and token contract addresses. Managing this per-transaction is error-prone.

### What WizPay Solves

- **Batched execution** — Multiple recipients are grouped into `TaskUnit` batches. The orchestrator processes all batches within a single task lifecycle.
- **State machine tracking** — Every task progresses through a defined set of states (`created → assigned → in_progress → executed/partial/failed`). Each transition is logged with timestamps, step names, and contextual data.
- **Multi-chain abstraction** — Adapters (Circle W3S, direct EVM via viem, Solana via `@solana/web3.js`) are selected by the execution router. Agents never interact with chain-specific libraries directly.
- **Retry and error handling** — BullMQ provides exponential backoff retries (3 attempts). Failed transactions are tracked individually via `TaskTransaction` records and can be retried independently through the poll queue.
- **Dual wallet mode** — W3S (Circle developer-controlled wallets) and Passkey (AA client-execution) are supported through the same task pipeline, selected at execution time by the `ExecutionRouterService`.

## System Boundaries

| Layer | Technology | Responsibility |
|-------|-----------|---------------|
| Frontend | Next.js | UI, payment composition, task polling, wallet session management |
| Backend | NestJS | Orchestration, task state, queue management, agent execution, adapter calls |
| Queue | BullMQ + Redis | Job scheduling, retry, concurrency control |
| Database | PostgreSQL + Prisma | Task, TaskUnit, TaskTransaction, TaskLog persistence |
| On-chain | Circle W3S / viem / @solana/web3.js | Token transfers, bridge burns/mints, swap execution |
