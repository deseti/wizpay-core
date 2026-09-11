import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { ExecutionIntentService } from './execution-intent.service';
import type { PrismaService } from '../database/prisma.service';
import type { PaymentRoutingService } from '../routing/payment-routing.service';

const databaseUrl = process.env.EXECUTION_INTENT_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const sender = '0x1000000000000000000000000000000000000001';
const recipient = '0x2000000000000000000000000000000000000002';
const usdc = '0x3000000000000000000000000000000000000003';

describePostgres('ExecutionIntentService PostgreSQL integration', () => {
  let admin: Client;
  let migrationClient: Client;
  let prisma: PrismaClient;
  let service: ExecutionIntentService;
  let databaseName: string;
  let isolatedUrl: string;

  beforeAll(async () => {
    const parsed = new URL(databaseUrl!);
    if (
      !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) ||
      parsed.pathname !== '/wizpay_execution_intent_test_admin'
    )
      throw new Error(
        'EXECUTION_INTENT_TEST_DATABASE_URL must target the local wizpay_execution_intent_test_admin database.',
      );
    databaseName = `wizpay_execution_intent_${randomUUID().replaceAll('-', '')}`;
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const clientUrl = new URL(databaseUrl!);
    clientUrl.pathname = `/${databaseName}`;
    isolatedUrl = clientUrl.toString();
    migrationClient = new Client({ connectionString: isolatedUrl });
    await migrationClient.connect();
    await migrationClient.query(
      'CREATE TABLE "Invoice" ("id" UUID PRIMARY KEY)',
    );
    const migration = await readFile(
      join(
        __dirname,
        '../database/migrations/20260910120000_execution_intents/migration.sql',
      ),
      'utf8',
    );
    await migrationClient.query(migration);
    await migrationClient.end();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: isolatedUrl }),
    });
    await prisma.$connect();
    service = createService(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    if (admin && databaseName) {
      await admin.query(`DROP DATABASE "${databaseName}"`);
      await admin.end();
    }
  });

  it('proves durable uniqueness, leases, immutable evidence, and restart recovery', async () => {
    const indexes = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'ExecutionIntent'
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
          network: 'arc-testnet',
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

    const restartedPrisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: isolatedUrl }),
    });
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
    network: 'arc-testnet',
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
    network: 'arc-testnet' as const,
    operation: 'SEND' as const,
    sourceWallet: sender,
    recipient,
    tokenIn: usdc,
    tokenOut: usdc,
    amountUnits: '1',
    externalReference: reference,
  };
}
