import { PrismaClient } from '@prisma/client';
import { ExecutionIntentService } from './execution-intent.service';
import type { PrismaService } from '../database/prisma.service';
import type { PaymentRoutingService } from '../routing/payment-routing.service';

import {
  hasPostgresTarget,
  openPostgresHarness,
} from '../../test/postgres-harness';

const describePostgres = hasPostgresTarget('EXECUTION_INTENT_TEST_DATABASE_URL')
  ? describe
  : describe.skip;
const sender = '0x1000000000000000000000000000000000000001';
const recipient = '0x2000000000000000000000000000000000000002';
const usdc = '0x3000000000000000000000000000000000000003';

describePostgres('ExecutionIntentService PostgreSQL integration', () => {
  let harness: Awaited<ReturnType<typeof openPostgresHarness>>;
  let prisma: PrismaClient;
  let service: ExecutionIntentService;

  beforeAll(async () => {
    harness = await openPostgresHarness(
      'EXECUTION_INTENT_TEST_DATABASE_URL',
      'wizpay_execution_intent_test_admin',
    );
    prisma = harness.prisma;
    service = createService(prisma);
  });

  afterAll(async () => {
    await harness?.close();
  });

  it('proves durable uniqueness, leases, immutable evidence, and restart recovery', async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = ${harness.schema} AND tablename = 'ExecutionIntent'
    `;
    const definitions = indexes.map((index) => index.indexdef).join('\n');
    expect(definitions).toMatch(/UNIQUE.*"logicalKey"/);
    expect(definitions).toMatch(/UNIQUE.*"idempotencyKey"/);
    expect(definitions).toMatch(/UNIQUE.*"transactionHash"/);

    const input = sendInput('send-1');
    const duplicateResults = await Promise.all(
      Array.from({ length: 8 }, () => service.acquire(input)),
    );
    expect(new Set(duplicateResults.map((intent) => intent.id)).size).toBe(1);
    expect(
      await prisma.executionIntent.count({
        where: { logicalKey: duplicateResults[0].logicalKey },
      }),
    ).toBe(1);
    await expect(
      service.acquire({ ...input, amountUnits: '2' }),
    ).rejects.toMatchObject({
      response: { code: 'EXECUTION_INTENT_IMMUTABLE_CONFLICT' },
    });

    const intent = duplicateResults[0];
    await expect(
      prisma.executionIntent.create({
        data: {
          network: 'arc-mainnet',
          operation: 'SEND',
          sourceWallet: sender,
          recipient,
          tokenIn: usdc,
          tokenOut: usdc,
          amountUnits: '3',
          externalReference: 'duplicate-idempotency',
          logicalKey: 'distinct-logical-key',
          requestFingerprint: 'distinct-request-fingerprint',
          idempotencyKey: intent.idempotencyKey,
          route: 'DIRECT_TRANSFER',
          updatedAt: new Date(),
        },
      }),
    ).rejects.toBeDefined();
    const leases = await Promise.allSettled([
      service.acquireLease(intent.id, 'worker-a', 60_000),
      service.acquireLease(intent.id, 'worker-b', 60_000),
    ]);
    expect(
      leases.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const winner = await service.get(intent.id);
    await expect(
      service.acquireLease(intent.id, 'worker-c', 60_000),
    ).rejects.toMatchObject({
      response: { code: 'EXECUTION_INTENT_ACTIVE_LEASE' },
    });
    await prisma.executionIntent.update({
      where: { id: intent.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await expect(
      service.acquireLease(intent.id, 'worker-c', 60_000),
    ).resolves.toMatchObject({ leaseOwner: 'worker-c' });
    expect(winner.attemptCount).toBe(1);

    await service.bindCircleCorrelation(intent.id, {
      challengeId: 'challenge-1',
      transactionId: 'transaction-1',
    });
    await expect(
      service.bindCircleCorrelation(intent.id, {
        challengeId: 'challenge-2',
        transactionId: 'transaction-1',
      }),
    ).rejects.toMatchObject({
      response: { code: 'EXECUTION_INTENT_IMMUTABLE_CONFLICT' },
    });
    const hash = `0x${'a'.repeat(64)}`;
    await service.bindTransactionHash(intent.id, hash);
    await expect(
      service.bindTransactionHash(intent.id, `0x${'b'.repeat(64)}`),
    ).rejects.toMatchObject({
      response: { code: 'EXECUTION_INTENT_TRANSACTION_HASH_CONFLICT' },
    });

    const another = await service.acquire(sendInput('send-2'));
    await expect(
      service.bindTransactionHash(another.id, hash),
    ).rejects.toMatchObject({
      response: { code: 'EXECUTION_INTENT_TRANSACTION_HASH_CONFLICT' },
    });
    await expect(
      service.transition(another.id, 'CREATED', 'COMPLETED'),
    ).rejects.toMatchObject({
      response: { code: 'EXECUTION_INTENT_INVALID_TRANSITION' },
    });

    const cancelled = await service.acquire(sendInput('terminal-guard'));
    await service.cancelUnsubmitted(cancelled.id, cancelled.idempotencyKey);
    await expect(
      service.acquireLease(cancelled.id, 'worker-terminal', 60_000),
    ).rejects.toMatchObject({
      response: { code: 'EXECUTION_INTENT_TERMINAL' },
    });
    await expect(
      service.bindKnownTransactionHash(
        cancelled.id,
        cancelled.idempotencyKey,
        `0x${'c'.repeat(64)}`,
      ),
    ).rejects.toThrow();

    const restartedPrisma = harness.createPrisma();
    await restartedPrisma.$connect();
    const restartedService = createService(restartedPrisma);
    await expect(restartedService.get(intent.id)).resolves.toMatchObject({
      circleChallengeId: 'challenge-1',
      circleTransactionId: 'transaction-1',
      transactionHash: hash,
    });
    await restartedPrisma.$disconnect();
  });
});

function createService(prisma: PrismaClient) {
  const routing = {
    network: 'arc-mainnet',
    chainId: 1,
    decide: (input: { tokenIn: string; tokenOut: string }) => ({
      kind: 'DIRECT_TRANSFER',
      provider: null,
      tokenIn: input.tokenIn,
      tokenOut: input.tokenOut,
    }),
    assertExecutable: (decision: unknown) => decision,
  } as unknown as PaymentRoutingService;
  return new ExecutionIntentService(
    prisma as unknown as PrismaService,
    routing,
  );
}

function sendInput(reference: string) {
  return {
    network: 'arc-mainnet' as const,
    operation: 'SEND' as const,
    sourceWallet: sender,
    recipient,
    tokenIn: usdc,
    tokenOut: usdc,
    amountUnits: '1',
    externalReference: reference,
  };
}
