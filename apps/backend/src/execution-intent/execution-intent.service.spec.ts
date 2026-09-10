import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPayrollBatchDigest,
  EXECUTION_INTENT_ERROR_CODES,
  ExecutionIntentService,
} from './execution-intent.service';

const USDC = '0x3600000000000000000000000000000000000000';
const WALLET = '0x1111111111111111111111111111111111111111';
const RECIPIENT = '0x2222222222222222222222222222222222222222';
const HASH = `0x${'a'.repeat(64)}`;

describe('ExecutionIntentService', () => {
  let store: IntentStore;
  let routing: {
    network: string;
    decide: jest.Mock;
    assertExecutable: jest.Mock;
  };
  let service: ExecutionIntentService;

  beforeEach(() => {
    store = new IntentStore();
    routing = {
      network: 'arc-testnet',
      chainId: 5_042_002,
      decide: jest.fn(({ network, operation, tokenIn, tokenOut }) => ({
        kind: 'DIRECT_TRANSFER',
        network,
        operation,
        tokenIn,
        tokenOut,
        provider: null,
      })),
      assertExecutable: jest.fn((decision) => decision),
    };
    service = new ExecutionIntentService(store as never, routing as never);
  });

  it('atomically coalesces concurrent identical acquisition and derives one idempotency key', async () => {
    const [left, right] = await Promise.all([
      service.acquire(sendInput()),
      service.acquire(sendInput()),
    ]);
    expect(left.id).toBe(right.id);
    expect(left.idempotencyKey).toBe(right.idempotencyKey);
    expect(store.rows).toHaveLength(1);
  });

  it('reuses the same intent across retries and backend service restarts', async () => {
    const first = await service.acquire(sendInput());
    const restarted = new ExecutionIntentService(
      store as never,
      routing as never,
    );
    const retry = await restarted.acquire(sendInput());
    expect(retry.id).toBe(first.id);
    expect(restarted.circleIdempotencyKey(retry)).toBe(first.idempotencyKey);
  });

  it('rejects conflicting immutable data for the same logical operation', async () => {
    await service.acquire(sendInput());
    await expect(
      service.acquire({ ...sendInput(), amountUnits: '2' }),
    ).rejects.toMatchObject({
      response: { code: EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT },
    });
  });

  it('does not allow an active lease to be stolen and safely reclaims an expired lease', async () => {
    const intent = await service.acquire(sendInput());
    const now = new Date('2026-09-10T00:00:00.000Z');
    await service.acquireLease(intent.id, 'worker-a', 5_000, now);
    await expect(
      service.acquireLease(intent.id, 'worker-b', 5_000, now),
    ).rejects.toMatchObject({
      response: { code: EXECUTION_INTENT_ERROR_CODES.ACTIVE_LEASE },
    });
    const reclaimed = await service.acquireLease(
      intent.id,
      'worker-b',
      5_000,
      new Date(now.getTime() + 5_001),
    );
    expect(reclaimed.leaseOwner).toBe('worker-b');
    expect(reclaimed.attemptCount).toBe(2);
  });

  it('holds browser-wallet submission behind one lease and requires explicit ambiguity recovery', async () => {
    const intent = await service.acquire(sendInput());
    const awaiting = await service.prepareWalletSignature(
      intent.id,
      intent.idempotencyKey,
      'browser-a',
      5_000,
    );
    expect(awaiting.status).toBe('AWAITING_WALLET_SIGNATURE');
    await expect(
      service.prepareWalletSignature(
        intent.id,
        intent.idempotencyKey,
        'browser-a',
        5_000,
      ),
    ).rejects.toMatchObject({
      response: { code: EXECUTION_INTENT_ERROR_CODES.INVALID_TRANSITION },
    });
    await expect(
      service.bindTransactionHash(intent.id, HASH, 'browser-b'),
    ).rejects.toMatchObject({
      response: { code: EXECUTION_INTENT_ERROR_CODES.ACTIVE_LEASE },
    });
    await expect(
      service.bindKnownTransactionHash(intent.id, intent.idempotencyKey, HASH),
    ).resolves.toMatchObject({ status: 'SUBMITTED', transactionHash: HASH });
    await expect(
      service.cancelUnsubmitted(intent.id, intent.idempotencyKey),
    ).rejects.toMatchObject({
      response: { code: EXECUTION_INTENT_ERROR_CODES.INVALID_TRANSITION },
    });
  });

  it('binds authenticated wallet, owner, contract, and calldata identity immutably', async () => {
    const intent = await service.acquire(sendInput());
    await expect(
      service.bindImmutableExecutionContext(intent.id, {
        ownerId: 'circle-user',
        walletId: 'wallet-1',
        contractAddress: USDC,
        calldataHash: HASH,
      }),
    ).resolves.toMatchObject({
      ownerId: 'circle-user',
      walletId: 'wallet-1',
      contractAddress: USDC.toLowerCase(),
      calldataHash: HASH,
    });
    await expect(
      service.bindImmutableExecutionContext(intent.id, {
        ownerId: 'other-user',
        walletId: 'wallet-1',
        contractAddress: USDC,
        calldataHash: HASH,
      }),
    ).rejects.toMatchObject({
      response: { code: EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT },
    });
  });

  it('keeps completion terminal and enforces the explicit state machine', async () => {
    const intent = await service.acquire(sendInput());
    await service.transition(intent.id, 'CREATED', 'SUBMISSION_PENDING');
    await service.transition(intent.id, 'SUBMISSION_PENDING', 'SUBMITTED');
    await service.bindTransactionHash(intent.id, HASH);
    await service.transition(intent.id, 'SUBMITTED', 'VERIFYING');
    await service.completeWithVerifiedReceipt(intent.id, receipt());
    await expect(
      service.transition(intent.id, 'COMPLETED', 'SUBMITTED'),
    ).rejects.toMatchObject({
      response: { code: EXECUTION_INTENT_ERROR_CODES.INVALID_TRANSITION },
    });
    await expect(
      service.acquireLease(intent.id, 'worker', 5_000),
    ).rejects.toMatchObject({
      response: { code: EXECUTION_INTENT_ERROR_CODES.TERMINAL },
    });
  });

  it('binds the same transaction hash idempotently and rejects replacement', async () => {
    const intent = await service.acquire(sendInput());
    const first = await service.bindTransactionHash(intent.id, HASH);
    const replay = await service.bindTransactionHash(
      intent.id,
      HASH.toUpperCase().replace('0X', '0x'),
    );
    expect(replay.transactionHash).toBe(first.transactionHash);
    await expect(
      service.bindTransactionHash(intent.id, `0x${'b'.repeat(64)}`),
    ).rejects.toMatchObject({
      response: { code: EXECUTION_INTENT_ERROR_CODES.HASH_CONFLICT },
    });
  });

  it('derives and reuses one Circle correlation for the durable intent', async () => {
    const intent = await service.acquire(sendInput());
    expect(service.circleIdempotencyKey(intent)).toBe(intent.idempotencyKey);
    const bound = await service.bindCircleCorrelation(intent.id, {
      challengeId: 'challenge-1',
      transactionId: 'circle-transaction-1',
    });
    expect(bound.circleChallengeId).toBe('challenge-1');
    await expect(
      service.bindCircleCorrelation(intent.id, {
        challengeId: 'challenge-2',
      }),
    ).rejects.toMatchObject({
      response: { code: EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT },
    });
  });

  it('cannot complete from wrong verified receipt data', async () => {
    const intent = await service.acquire(sendInput());
    await service.transition(intent.id, 'CREATED', 'SUBMISSION_PENDING');
    await service.transition(intent.id, 'SUBMISSION_PENDING', 'SUBMITTED');
    await service.bindTransactionHash(intent.id, HASH);
    await service.transition(intent.id, 'SUBMITTED', 'VERIFYING');
    await expect(
      service.completeWithVerifiedReceipt(intent.id, {
        ...receipt(),
        amountUnits: '2',
      }),
    ).rejects.toMatchObject({
      response: { code: EXECUTION_INTENT_ERROR_CODES.RECEIPT_MISMATCH },
    });
    expect((await service.get(intent.id)).status).toBe('VERIFYING');
  });

  it('never calls provider logic for a same-token intent', async () => {
    const intent = await service.acquire(sendInput());
    expect(intent.route).toBe('DIRECT_TRANSFER');
    expect(intent.provider).toBeNull();
    expect(routing.decide).toHaveBeenCalledTimes(1);
  });

  it('coalesces an open invoice settlement and rejects paid invoice acquisition', async () => {
    store.invoices.push({
      publicId: 'invoice-1',
      status: 'OPEN',
      expiresAt: new Date('2026-09-11T00:00:00.000Z'),
      chainId: 5_042_002,
      merchantWalletAddress: RECIPIENT,
      tokenAddress: USDC,
      amountUnits: '1',
      settlementKind: 'PAYMENT_LINK',
    });
    const input = {
      ...sendInput(),
      operation: 'PAYMENT_LINK_SETTLEMENT' as const,
      externalReference: 'invoice-1',
    };
    const [first, duplicate] = await Promise.all([
      service.acquire(input),
      service.acquire(input),
    ]);
    expect(duplicate.id).toBe(first.id);
    await expect(
      service.acquire({
        ...input,
        operation: 'INVOICE_SETTLEMENT',
      }),
    ).rejects.toMatchObject({
      response: { code: EXECUTION_INTENT_ERROR_CODES.BUSINESS_STATE },
    });

    store.invoices.push({
      ...store.invoices[0],
      publicId: 'invoice-2',
      status: 'PAID',
    });
    await expect(
      service.acquire({ ...input, externalReference: 'invoice-2' }),
    ).rejects.toMatchObject({
      response: { code: EXECUTION_INTENT_ERROR_CODES.BUSINESS_STATE },
    });
  });

  it('binds payroll digest to recipient, order, token, and exact amount', () => {
    const base = [
      { recipient: WALLET, token: USDC, amountUnits: '1' },
      { recipient: RECIPIENT, token: USDC, amountUnits: '2' },
    ];
    const digest = createPayrollBatchDigest(base);
    expect(createPayrollBatchDigest([...base].reverse())).not.toBe(digest);
    expect(
      createPayrollBatchDigest([{ ...base[0], recipient: RECIPIENT }, base[1]]),
    ).not.toBe(digest);
    expect(
      createPayrollBatchDigest([{ ...base[0], amountUnits: '3' }, base[1]]),
    ).not.toBe(digest);
    expect(
      createPayrollBatchDigest([
        { ...base[0], token: '0x3333333333333333333333333333333333333333' },
        base[1],
      ]),
    ).not.toBe(digest);
  });
});

describe('execution intent migration safety', () => {
  it('is additive and contains no data mutation or destructive drop', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../database/migrations/20260910120000_execution_intents/migration.sql',
      ),
      'utf8',
    );
    expect(sql).toMatch(/CREATE TABLE "ExecutionIntent"/);
    expect(sql).not.toMatch(/\b(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/i);
  });
});

function sendInput() {
  return {
    network: 'arc-testnet' as const,
    operation: 'SEND' as const,
    sourceWallet: WALLET,
    recipient: RECIPIENT,
    tokenIn: USDC,
    tokenOut: USDC,
    amountUnits: '1',
    externalReference: 'SEND-business-operation-1',
  };
}

function receipt() {
  return {
    network: 'arc-testnet',
    transactionHash: HASH as `0x${string}`,
    sourceWallet: WALLET,
    token: USDC,
    recipient: RECIPIENT,
    amountUnits: '1',
  };
}

class IntentStore {
  rows: any[] = [];
  invoices: any[] = [];

  invoice = {
    findUnique: async ({ where }: any) =>
      this.invoices.find((invoice) => invoice.publicId === where.publicId) ??
      null,
  };

  executionIntent = {
    upsert: async ({ where, create }: any) => {
      const existing = this.rows.find(
        (row) => row.logicalKey === where.logicalKey,
      );
      if (existing) return { ...existing };
      const row = {
        id: randomUUID(),
        status: 'CREATED',
        attemptCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        circleChallengeId: null,
        circleTransactionId: null,
        transactionHash: null,
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        failureCode: null,
        ...create,
      };
      this.rows.push(row);
      return { ...row };
    },
    findUnique: async ({ where }: any) => {
      const [key, value] = Object.entries(where)[0];
      const row = this.rows.find((candidate) => candidate[key] === value);
      return row ? { ...row } : null;
    },
    updateMany: async ({ where, data }: any) => {
      const row = this.rows.find((candidate) => candidate.id === where.id);
      if (!row || !matches(row, where)) return { count: 0 };
      for (const [key, value] of Object.entries(data)) {
        if (value && typeof value === 'object' && 'increment' in value)
          row[key] += (value as any).increment;
        else row[key] = value;
      }
      row.updatedAt = new Date();
      return { count: 1 };
    },
  };

  $transaction = async (callback: (tx: this) => unknown) => callback(this);
}

function matches(row: any, where: any): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(value as any[]).some((condition) => matches(row, condition)))
        return false;
    } else if (key === 'status' && value && typeof value === 'object') {
      if ((value as any).notIn?.includes(row.status)) return false;
    } else if (key === 'leaseExpiresAt' && value && typeof value === 'object') {
      if (!(row.leaseExpiresAt && row.leaseExpiresAt <= (value as any).lte))
        return false;
    } else if (row[key] !== value) return false;
  }
  return true;
}
