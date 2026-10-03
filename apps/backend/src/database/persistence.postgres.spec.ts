import { ConfigService } from '@nestjs/config';
import { Client } from 'pg';
import { getArcNetworkByKey, getArcRpcResource } from '@wizpay/arc-network';
import {
  hasPostgresTarget,
  openPostgresHarness,
} from '../../test/postgres-harness';
import { checkPostgresCatalog } from '../../test/check-postgres-catalog';
import { WalletAuthService } from '../modules/wallet/wallet-auth.service';
import { ActivityService } from '../activity/activity.service';
import { TaskUnitService } from '../task/task-unit.service';
import { TaskMapperService } from '../task/task-mapper.service';
import { TaskTransactionService } from '../task/task-transaction.service';

const describePostgres = hasPostgresTarget('EXECUTION_INTENT_TEST_DATABASE_URL')
  ? describe
  : describe.skip;
const wallet = '0x1000000000000000000000000000000000000001';
const recipient = '0x2000000000000000000000000000000000000002';
const token = '0x3000000000000000000000000000000000000003';
const hash = `0x${'a'.repeat(64)}`;

describePostgres('shared PostgreSQL persistence contracts', () => {
  let harness: Awaited<ReturnType<typeof openPostgresHarness>>;
  beforeAll(async () => {
    harness = await openPostgresHarness(
      'EXECUTION_INTENT_TEST_DATABASE_URL',
      'wizpay_execution_intent_test_admin',
    );
  });
  afterAll(async () => {
    await harness?.close();
  });

  it('reproduces migrated tables, defaults, enums, indexes and foreign keys', async () => {
    // Prisma queries use the adapter schema; the read-only catalog checker can
    // run through that same driver without a second query-by-query connection.
    const facade = {
      query: (sql: string, values: unknown[]) =>
        harness.prisma
          .$queryRawUnsafe(sql, ...values)
          .then((rows) => ({ rows })),
    };
    expect(
      await checkPostgresCatalog(facade as unknown as Client, harness.schema),
    ).toEqual({
      tables: 15,
      indexes: 51,
      foreignKeys: 4,
      enums: 6,
    });
  });

  it('persists one-time wallet challenges and hashed, revocable owner sessions', async () => {
    const network = getArcNetworkByKey('arc-mainnet');
    const rpc = getArcRpcResource('arc-mainnet');
    if (rpc.status !== 'available') throw new Error('Registry RPC unavailable');
    const auth = new WalletAuthService(
      harness.prisma as never,
      new ConfigService({ arcNetwork: { ...network, rpcUrl: rpc.value.url } }),
    );
    // Cryptographic verification is independently tested; no live chain call.
    const client = (
      auth as unknown as {
        publicClient: { verifyMessage: () => Promise<boolean> };
      }
    ).publicClient;
    jest.spyOn(client, 'verifyMessage').mockResolvedValue(true);
    const challenge = await auth.createChallenge(wallet, 5042);
    const session = await auth.verifyChallenge(challenge.challengeId, '0x1234');
    await expect(
      auth.verifyChallenge(challenge.challengeId, '0x1234'),
    ).rejects.toThrow();
    const principal = await auth.authenticate(`Bearer ${session.sessionToken}`);
    expect(principal.merchantWalletAddress.toLowerCase()).toBe(wallet);
    const persisted =
      await harness.prisma.activityAuthSession.findFirstOrThrow();
    expect(persisted.sessionHash).not.toBe(session.sessionToken);
    expect(persisted.ownerUserId).toBe(principal.merchantUserId);
    await auth.revoke(`Bearer ${session.sessionToken}`);
    await expect(
      auth.authenticate(`Bearer ${session.sessionToken}`),
    ).rejects.toThrow();
  });

  it('keeps TaskUnit results, counters and logs atomic and duplicate reports idempotent', async () => {
    const prisma = harness.prisma;
    const mapper = new TaskMapperService(
      prisma as never,
      new TaskTransactionService(prisma as never),
    );
    const units = new TaskUnitService(prisma as never, mapper);
    const task = await prisma.task.create({
      data: {
        type: 'payroll',
        status: 'created',
        payload: {},
        totalUnits: 2,
        units: {
          create: [
            { type: 'payroll', index: 0, payload: {} },
            { type: 'payroll', index: 1, payload: {} },
          ],
        },
      },
      include: { units: true },
    });
    await units.reportUnit(task.id, task.units[0].id, {
      status: 'SUCCESS',
      txHash: hash,
    });
    await units.reportUnit(task.id, task.units[0].id, {
      status: 'SUCCESS',
      txHash: hash,
    });
    expect(
      await prisma.task.findUniqueOrThrow({ where: { id: task.id } }),
    ).toMatchObject({ completedUnits: 1 });
    const spy = jest
      .spyOn(mapper, 'getTaskDetailsInTransaction')
      .mockRejectedValueOnce(new Error('Test rollback'));
    await expect(
      units.reportUnit(task.id, task.units[1].id, {
        status: 'SUCCESS',
        txHash: hash,
      }),
    ).rejects.toThrow('Test rollback');
    spy.mockRestore();
    expect(
      await prisma.taskUnit.findUniqueOrThrow({
        where: { id: task.units[1].id },
      }),
    ).toMatchObject({ status: 'PENDING' });
    expect(
      await prisma.task.findUniqueOrThrow({ where: { id: task.id } }),
    ).toMatchObject({ completedUnits: 1 });
    expect(await prisma.taskLog.count({ where: { taskId: task.id } })).toBe(1);
  });

  it('preserves InvoicePayment, bridge evidence and verified-swap uniqueness', async () => {
    const prisma = harness.prisma;
    const invoice = () =>
      prisma.invoice.create({
        data: {
          publicId: crypto.randomUUID(),
          merchantUserId: 'test-owner',
          merchantWalletAddress: wallet,
          chainId: 5042,
          tokenAddress: token,
          tokenSymbol: 'USDC',
          tokenDecimals: 6,
          amountUnits: '1',
          title: 'Offline database test',
        },
      });
    const first = await invoice(),
      second = await invoice();
    await prisma.invoicePayment.create({
      data: { invoiceId: first.id, transactionHash: hash },
    });
    await expect(
      prisma.invoicePayment.create({
        data: { invoiceId: first.id, transactionHash: `0x${'b'.repeat(64)}` },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.invoicePayment.create({
        data: { invoiceId: second.id, transactionHash: hash },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      prisma.invoicePayment.create({
        data: {
          invoiceId: crypto.randomUUID(),
          transactionHash: `0x${'c'.repeat(64)}`,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    const bridge = await prisma.bridgeTransaction.create({
      data: {
        taskId: 'offline-bridge',
        status: 'verifying_destination',
        payload: {},
        messageHash: 'offline-message',
        nonce: 'offline-nonce',
        destinationTransactionHash: hash,
        destinationLeaseId: crypto.randomUUID(),
        destinationLeaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const restarted = harness.createPrisma();
    expect(
      await restarted.bridgeTransaction.findUniqueOrThrow({
        where: { id: bridge.id },
      }),
    ).toMatchObject({
      messageHash: 'offline-message',
      destinationTransactionHash: hash,
      destinationLeaseId: bridge.destinationLeaseId,
    });
    for (const evidence of [
      { messageHash: bridge.messageHash },
      { nonce: bridge.nonce },
      { destinationTransactionHash: hash },
      { destinationLeaseId: bridge.destinationLeaseId },
    ])
      await expect(
        prisma.bridgeTransaction.create({
          data: {
            taskId: crypto.randomUUID(),
            status: 'created',
            payload: {},
            ...evidence,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    const swap = {
      transactionHash: hash,
      walletAddress: wallet,
      chainId: 5042,
      tokenIn: token,
      tokenOut: token,
      amountIn: '1',
      amountOut: '1',
      completedAt: new Date(),
    };
    await prisma.verifiedSwapTransaction.create({ data: swap });
    await expect(
      prisma.verifiedSwapTransaction.create({ data: swap }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('preserves activity ownership, projection idempotency and durable sync lease contention', async () => {
    const prisma = harness.prisma;
    const activity = new ActivityService(prisma as never);
    const projection = {
      ownerUserId: 'owner-a',
      walletAddress: wallet,
      type: 'send' as const,
      status: 'completed' as const,
      source: 'offline',
      idempotencyKey: 'offline-idempotency',
      sourceReferenceType: 'offline',
      sourceReferenceId: 'offline-1',
    };
    const row = await activity.upsert(projection);
    expect((await activity.upsert(projection)).id).toBe(row.id);
    await expect(
      activity.upsert({ ...projection, ownerUserId: 'owner-b' }),
    ).rejects.toThrow('ownership conflict');
    const principal = {
      merchantUserId: 'owner-b',
      merchantWalletAddress: recipient as `0x${string}`,
      merchantDisplayLabel: null,
    };
    await expect(activity.getOwned(principal, row.id)).rejects.toThrow();
    const state = await prisma.activitySyncState.create({
      data: {
        ownerUserId: 'owner-a',
        walletAddress: wallet,
        source: 'external_wallet',
      },
    });
    const claim = (leaseId: string) =>
      prisma.activitySyncState.updateMany({
        where: {
          id: state.id,
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: new Date() } },
          ],
        },
        data: { leaseId, leaseExpiresAt: new Date(Date.now() + 60_000) },
      });
    const claimed = await Promise.all([claim('lease-a'), claim('lease-b')]);
    expect(claimed.map((result) => result.count).sort()).toEqual([0, 1]);
    await prisma.activitySyncState.update({
      where: { id: state.id },
      data: { leaseExpiresAt: new Date(0) },
    });
    expect((await claim('lease-c')).count).toBe(1);
  });
});
