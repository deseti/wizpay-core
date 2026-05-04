---
title: "Introduction"
description: "On-chain batch payment execution with atomic settlement."
---

# Introduction

WizPay is a programmable on-chain payment execution system. It accepts batches of payment instructions — payroll distributions, token swaps, cross-chain bridges, FX conversions — and executes them through a unified orchestration layer with deterministic state tracking.

## Technical Definition

WizPay is a **task-based execution engine** that:

- Accepts structured payment payloads via HTTP
- Validates, batches, and queues them for asynchronous processing
- Routes each task to a domain-specific agent (payroll, swap, bridge, FX, liquidity)
- Settles on-chain through chain-specific adapters (Circle W3S, viem, Solana Web3.js)
- Tracks every state transition in an append-only audit log

The system is not a smart contract protocol. It is a **backend orchestration layer** that coordinates off-chain logic with on-chain settlement.

## Problem Statement

Executing on-chain payments individually introduces compounding costs:

- **Gas overhead** — Each transaction pays a base gas cost. N separate transfers ≈ N× the cost of a batched approach.
- **No atomicity** — If transfer 47 of 100 fails, there is no built-in mechanism to identify which succeeded, which failed, and what to retry.
- **Multi-chain fragmentation** — Paying across EVM chains and Solana requires different signing flows, RPC endpoints, and token addresses. Managing this per-transaction is operationally fragile.
- **No audit trail** — Individual wallet-to-wallet transfers produce no structured record of intent, execution state, or outcome.

## What WizPay Provides

| Capability | Mechanism |
|---|---|
| Batch execution | Multiple recipients grouped into `TaskUnit` records, processed within a single task lifecycle |
| State tracking | 8-state machine (`created → assigned → in_progress → executed/partial/failed`) with enforced transitions |
| Multi-chain abstraction | Adapters selected by execution router — agents never interact with chain libraries directly |
| Retry semantics | BullMQ exponential backoff (3 attempts), idempotent execution guards |
| Dual signing model | W3S (backend-signed via Circle) and Passkey (client-signed via AA wallet) |

## System Boundary

| Layer | Technology | Responsibility |
|---|---|---|
| Frontend | Next.js | UI composition, task polling, wallet session |
| Backend | NestJS | Orchestration, state machine, queue, agent execution |
| Queue | BullMQ + Redis | Job scheduling, retry, concurrency |
| Database | PostgreSQL + Prisma | Task, unit, transaction, log persistence |
| On-chain | Circle W3S / viem / Solana Web3.js | Token transfers, bridge burns/mints, swaps |
