/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { NotFoundException } from '@nestjs/common';
import { ActivityService } from './activity.service';

const walletA = '0x1111111111111111111111111111111111111111' as const;
const walletB = '0x2222222222222222222222222222222222222222' as const;
const principal = (user: string, wallet: `0x${string}`) => ({
  merchantUserId: user,
  merchantWalletAddress: wallet,
  merchantDisplayLabel: null,
});

describe('ActivityService privacy and idempotency', () => {
  let rows: any[];
  let prisma: any;
  let service: ActivityService;

  beforeEach(() => {
    rows = [];
    const sessions: any[] = [];
    const syncState: any = {
      id: 'sync-1',
      ownerUserId: 'user-a',
      walletAddress: walletA,
      source: 'external_wallet',
      checkpointTransactionId: null,
      leaseId: null,
      leaseExpiresAt: null,
      lastStartedAt: null,
      lastCompletedAt: null,
      nextAllowedAt: null,
    };
    prisma = {
      activity: {
        findUnique: jest.fn(
          async ({ where }: any) =>
            rows.find((row) => row.idempotencyKey === where.idempotencyKey) ??
            null,
        ),
        upsert: jest.fn(async ({ where, create, update }: any) => {
          const found = rows.find(
            (row) => row.idempotencyKey === where.idempotencyKey,
          );
          if (found) {
            Object.assign(found, update, {
              updatedAt: new Date('2026-08-31T01:00:00Z'),
            });
            return found;
          }
          const row = {
            id: `activity-${rows.length + 1}`,
            ...create,
            createdAt: new Date('2026-08-31T00:00:00Z'),
            updatedAt: new Date('2026-08-31T00:00:00Z'),
          };
          rows.push(row);
          return row;
        }),
        findMany: jest.fn(async ({ where, take }: any) =>
          rows
            .filter(
              (row) =>
                row.ownerUserId === where.ownerUserId &&
                (!where.walletAddress ||
                  row.walletAddress === where.walletAddress),
            )
            .slice(0, take),
        ),
        findFirst: jest.fn(
          async ({ where }: any) =>
            rows.find(
              (row) =>
                row.id === where.id &&
                row.ownerUserId === where.ownerUserId &&
                (!where.walletAddress ||
                  row.walletAddress === where.walletAddress),
            ) ?? null,
        ),
        update: jest.fn(async ({ where, data }: any) => {
          const row = rows.find((candidate) => candidate.id === where.id);
          Object.assign(row, data);
          return row;
        }),
      },
      invoicePayment: { findMany: jest.fn(async () => []) },
      executionIntent: { findMany: jest.fn(async () => []) },
      task: { findMany: jest.fn(async () => []) },
      bridgeTransaction: { findMany: jest.fn(async () => []) },
      verifiedSwapTransaction: { findMany: jest.fn(async () => []) },
      activityAuthSession: {
        findFirst: jest.fn(async ({ where }: any) =>
          sessions.find(
            (session) =>
              session.sessionHash === where.sessionHash &&
              session.expiresAt > where.expiresAt.gt,
          ) ?? null,
        ),
        deleteMany: jest.fn(async ({ where }: any) => {
          for (let index = sessions.length - 1; index >= 0; index -= 1)
            if (sessions[index].ownerUserId === where.ownerUserId)
              sessions.splice(index, 1);
          return { count: 1 };
        }),
        create: jest.fn(async ({ data }: any) => {
          const session = { id: `session-${sessions.length + 1}`, ...data };
          sessions.push(session);
          return session;
        }),
      },
      activitySyncState: {
        upsert: jest.fn(async () => ({ ...syncState })),
        updateMany: jest.fn(async ({ data }: any) => {
          Object.assign(syncState, data);
          return { count: 1 };
        }),
        findUnique: jest.fn(async () => ({ ...syncState })),
      },
    };
    service = new ActivityService(prisma);
  });

  it('lists only the authenticated owner and a new user gets an empty page', async () => {
    await service.upsert({
      ownerUserId: 'user-a',
      walletAddress: walletA.toUpperCase().replace('0X', '0x'),
      type: 'send',
      direction: 'outgoing',
      status: 'submitted',
      source: 'external_wallet',
      idempotencyKey: 'wallet:1',
      sourceReferenceType: 'wallet_transfer',
      sourceReferenceId: '1',
    });
    await expect(
      service.list(principal('user-a', walletA), {}),
    ).resolves.toMatchObject({ items: [{ type: 'send' }] });
    await expect(
      service.list(principal('user-b', walletB), {}),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });

  it('applies bounded pagination and validated type/status filters to the authenticated owner query', async () => {
    const cursor = Buffer.from(
      JSON.stringify({
        createdAt: '2026-08-31T00:00:00.000Z',
        id: 'activity-cursor',
      }),
    ).toString('base64url');
    await service.list(principal('user-a', walletA), {
      cursor,
      limit: 999,
      type: 'swap',
      status: 'completed',
    });
    expect(prisma.activity.findMany).toHaveBeenLastCalledWith({
      where: {
        ownerUserId: 'user-a',
        walletAddress: walletA,
        type: 'swap',
        status: 'completed',
        OR: [
          { createdAt: { lt: new Date('2026-08-31T00:00:00.000Z') } },
          {
            createdAt: new Date('2026-08-31T00:00:00.000Z'),
            id: { lt: 'activity-cursor' },
          },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
  });

  it('keeps GET-style list reads database-only without provider calls', async () => {
    await service.upsert({
      ownerUserId: 'user-a',
      walletAddress: walletA,
      type: 'send',
      status: 'completed',
      source: 'external_wallet',
      idempotencyKey: 'wallet:stored',
      sourceReferenceType: 'wallet_transfer',
      sourceReferenceId: 'stored',
    });
    await expect(
      service.list(principal('user-a', walletA), {}),
    ).resolves.toMatchObject({ items: [{ sourceReferenceId: 'stored' }] });
    expect(prisma.activity.upsert).toHaveBeenCalledTimes(1);
  });

  it('returns not found when User B guesses User A activity ID', async () => {
    await service.upsert({
      ownerUserId: 'user-a',
      walletAddress: walletA,
      type: 'swap',
      status: 'pending',
      source: 'external_wallet',
      idempotencyKey: 'wallet:1',
      sourceReferenceType: 'wallet_transfer',
      sourceReferenceId: '1',
    });
    await expect(
      service.getOwned(principal('user-b', walletB), 'activity-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('normalizes wallets and progresses one logical row without duplication', async () => {
    const base = {
      ownerUserId: 'user-a',
      walletAddress: '0x1111111111111111111111111111111111111111',
      type: 'swap' as const,
      status: 'pending' as const,
      source: 'external_wallet',
      idempotencyKey: 'wallet:1',
      sourceReferenceType: 'wallet_transfer',
      sourceReferenceId: '1',
    };
    await service.upsert(base);
    await service.upsert({
      ...base,
      walletAddress: '0x1111111111111111111111111111111111111111',
      status: 'completed',
      txHash: `0x${'a'.repeat(64)}`,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      walletAddress: walletA,
      status: 'completed',
    });
  });

  it('allows authoritative completion to correct a recoverable timeout state', async () => {
    const base = {
      ownerUserId: 'user-a',
      walletAddress: walletA,
      type: 'send' as const,
      source: 'external_wallet',
      idempotencyKey: 'wallet:recoverable',
      sourceReferenceType: 'wallet_transfer',
      sourceReferenceId: 'recoverable',
    };
    await service.upsert({ ...base, status: 'recovery_required' });
    await service.upsert({ ...base, status: 'completed' });
    await service.upsert({ ...base, status: 'confirming' });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('completed');
  });

  it('rejects an idempotency key reused across owners', async () => {
    const base = {
      ownerUserId: 'user-a',
      walletAddress: walletA,
      type: 'send' as const,
      status: 'pending' as const,
      source: 'external_wallet',
      idempotencyKey: 'wallet:1',
      sourceReferenceType: 'wallet_transfer',
      sourceReferenceId: '1',
    };
    await service.upsert(base);
    await expect(
      service.upsert({
        ...base,
        ownerUserId: 'user-b',
        walletAddress: walletB,
      }),
    ).rejects.toThrow('ownership conflict');
  });

  it('does not expose owner identity or credential/provider payload fields in the DTO', async () => {
    await service.upsert({
      ownerUserId: 'user-a',
      walletAddress: walletA,
      type: 'invoice_payment',
      direction: 'incoming',
      status: 'completed',
      source: 'invoice_receipt',
      idempotencyKey: 'invoice:1',
      sourceReferenceType: 'invoice_payment',
      sourceReferenceId: '1',
      metadata: { invoicePublicId: 'INV-1' },
    });
    const dto = (await service.getOwned(
      principal('user-a', walletA),
      'activity-1',
    )) as Record<string, unknown>;
    expect(dto).not.toHaveProperty('ownerUserId');
    expect(dto).not.toHaveProperty('walletAddress');
    expect(dto).not.toHaveProperty('userToken');
    expect(JSON.stringify(dto)).not.toMatch(
      /credential|signature|typedData|permit2|providerResponse/i,
    );
  });

  it('projects only verified Mainnet invoice payments for the canonical wallet', async () => {
    const txHash = `0x${'c'.repeat(64)}`;
    prisma.invoicePayment.findMany.mockResolvedValue([
      {
        id: 'payment-1',
        transactionHash: txHash,
        status: 'VERIFIED',
        payerAddress: walletB,
        verifiedAt: new Date('2026-08-31T00:00:00Z'),
        createdAt: new Date('2026-08-31T00:00:00Z'),
        invoice: {
          merchantUserId: 'user-a',
          merchantWalletAddress: walletA,
          chainId: 5042,
          tokenSymbol: 'USDC',
          tokenAddress: '0x3600000000000000000000000000000000000000',
          amountUnits: '1000000',
          publicId: 'abcdefghijklmnopqrstuv',
        },
      },
      {
        id: 'payment-foreign-chain',
        transactionHash: `0x${'d'.repeat(64)}`,
        status: 'VERIFIED',
        payerAddress: walletB,
        verifiedAt: new Date('2026-08-31T00:00:00Z'),
        createdAt: new Date('2026-08-31T00:00:00Z'),
        invoice: {
          merchantUserId: 'user-a',
          merchantWalletAddress: walletA,
          chainId: 1,
          tokenSymbol: 'USDC',
          tokenAddress: '0x3600000000000000000000000000000000000000',
          amountUnits: '1000000',
          publicId: 'foreign-public-id-1234',
        },
      },
    ]);
    const accepted = await service.projectPersisted(
      principal('user-a', walletA),
    );
    expect(accepted).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'invoice_payment',
      direction: 'incoming',
      status: 'completed',
      source: 'invoice_receipt',
      chainId: 5042,
      txHash,
    });
  });

  it('projects completed sends and ignores records outside the completed query', async () => {
    const txHash = `0x${'1'.repeat(64)}`;
    prisma.executionIntent.findMany.mockResolvedValue([
      {
        id: 'send-intent',
        network: 'arc-mainnet',
        operation: 'SEND',
        sourceWallet: walletA,
        recipient: walletB,
        tokenOut: '0x3600000000000000000000000000000000000000',
        amountUnits: '10000',
        externalReference: 'SEND-1',
        transactionHash: txHash,
        completedAt: new Date('2026-09-22T00:00:00Z'),
        updatedAt: new Date('2026-09-22T00:00:00Z'),
      },
      {
        id: 'send-other-network',
        network: 'arc-testnet',
        operation: 'SEND',
        sourceWallet: walletA,
        recipient: walletB,
        tokenOut: '0x3600000000000000000000000000000000000000',
        amountUnits: '10000',
        externalReference: 'SEND-OTHER',
        transactionHash: `0x${'9'.repeat(64)}`,
        completedAt: new Date('2026-09-22T00:00:00Z'),
        updatedAt: new Date('2026-09-22T00:00:00Z'),
      },
    ]);
    await service.projectPersisted(principal('user-a', walletA));
    expect(rows.filter((row) => row.type === 'send')).toHaveLength(1);
    expect(rows).toContainEqual(
      expect.objectContaining({
        type: 'send',
        status: 'completed',
        txHash,
        counterparty: walletB,
      }),
    );
    expect(prisma.executionIntent.findMany).toHaveBeenCalledWith({
      where: {
        status: 'COMPLETED',
        network: 'arc-mainnet',
        transactionHash: { not: null },
        operation: { in: ['SEND', 'PAYROLL'] },
      },
    });
  });

  it('aggregates same-token, cross-token, and mixed payroll into deterministic run rows', async () => {
    const usdc = '0x3600000000000000000000000000000000000000';
    const eurc = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
    const completedAt = new Date('2026-09-22T00:00:00Z');
    prisma.executionIntent.findMany.mockResolvedValue([
      {
        id: 'pay-usdc', network: 'arc-mainnet', operation: 'PAYROLL', sourceWallet: walletA,
        tokenOut: usdc, amountUnits: '20000', externalReference: 'RUN-MIXED-USDC',
        transactionHash: `0x${'2'.repeat(64)}`, taskId: 'task-usdc', completedAt, updatedAt: completedAt,
      },
      {
        id: 'pay-eurc', network: 'arc-mainnet', operation: 'PAYROLL', sourceWallet: walletA,
        tokenOut: eurc, amountUnits: '10000', externalReference: 'RUN-MIXED-EURC',
        transactionHash: `0x${'3'.repeat(64)}`, taskId: 'task-eurc', completedAt, updatedAt: completedAt,
      },
      {
        id: 'pay-single', network: 'arc-mainnet', operation: 'PAYROLL', sourceWallet: walletA,
        tokenOut: usdc, amountUnits: '30000', externalReference: 'RUN-SINGLE',
        transactionHash: `0x${'4'.repeat(64)}`, taskId: 'task-single', completedAt, updatedAt: completedAt,
      },
      {
        id: 'pay-cross', network: 'arc-mainnet', operation: 'PAYROLL', sourceWallet: walletA,
        tokenOut: eurc, amountUnits: '10000', externalReference: 'RUN-CROSS',
        transactionHash: `0x${'5'.repeat(64)}`, taskId: 'task-cross', completedAt, updatedAt: completedAt,
      },
    ]);
    prisma.task.findMany.mockResolvedValue([
      { id: 'task-usdc', metadata: { totalRecipients: 2 } },
      { id: 'task-eurc', metadata: { totalRecipients: 1 } },
      { id: 'task-single', metadata: { totalRecipients: 3 } },
      { id: 'task-cross', metadata: { totalRecipients: 1 } },
    ]);
    await service.projectPersisted(principal('user-a', walletA));
    await service.projectPersisted(principal('user-a', walletA));
    const payroll = rows.filter((row) => row.type === 'payroll');
    expect(payroll).toHaveLength(3);
    expect(payroll).toContainEqual(
      expect.objectContaining({
        inputTokenSymbol: undefined,
        inputAmount: undefined,
        metadata: expect.objectContaining({
          referenceId: 'RUN-MIXED',
          transactionCount: 3,
          transactionHashes: [`0x${'2'.repeat(64)}`, `0x${'3'.repeat(64)}`],
          tokenTotals: { USDC: '20000', EURC: '10000' },
        }),
      }),
    );
    expect(payroll).toContainEqual(
      expect.objectContaining({
        inputTokenSymbol: 'USDC',
        inputAmount: '30000',
        metadata: expect.objectContaining({ transactionCount: 3 }),
      }),
    );
    expect(payroll).toContainEqual(
      expect.objectContaining({
        inputTokenSymbol: 'EURC',
        inputAmount: '10000',
      }),
    );
  });

  it('projects only verified swaps and completed destination bridges for the owned wallet', async () => {
    prisma.verifiedSwapTransaction.findMany.mockResolvedValue([
      {
        id: 'swap-1', transactionHash: `0x${'6'.repeat(64)}`, walletAddress: walletA,
        chainId: 5042, tokenIn: '0x3600000000000000000000000000000000000000',
        tokenOut: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', amountIn: '10000',
        amountOut: '9900', completedAt: new Date('2026-09-22T00:00:00Z'),
      },
    ]);
    prisma.bridgeTransaction.findMany.mockResolvedValue([
      {
        id: 'bridge-1', taskId: 'bridge-task', updatedAt: new Date('2026-09-22T00:00:00Z'),
        payload: { walletAddress: walletA, recipientAddress: walletA, sourceChainId: 5042,
          destinationChainId: 8453, sourceUsdcAddress: walletA, destinationUsdcAddress: walletB, amount: '10000' },
        result: { sourceTransactionHash: `0x${'7'.repeat(64)}`,
          destinationTransactionHash: `0x${'8'.repeat(64)}`, mintAmount: '9990',
          destinationReceiptVerified: true, completedAt: '2026-09-22T00:00:00Z' },
      },
      {
        id: 'bridge-unverified', taskId: 'bridge-task-2', updatedAt: new Date('2026-09-22T00:00:00Z'),
        payload: { walletAddress: walletA, recipientAddress: walletA, sourceChainId: 5042,
          destinationChainId: 8453, amount: '10000' },
        result: { destinationTransactionHash: `0x${'9'.repeat(64)}`, completedAt: '2026-09-22T00:00:00Z' },
      },
    ]);
    await service.projectPersisted(principal('user-a', walletA));
    expect(rows).toContainEqual(expect.objectContaining({ type: 'swap', status: 'completed' }));
    expect(rows.filter((row) => row.type === 'bridge')).toEqual([
      expect.objectContaining({ type: 'bridge', status: 'completed', sourceReferenceId: 'bridge-1' }),
    ]);
    expect(prisma.bridgeTransaction.findMany).toHaveBeenCalledWith({ where: { status: 'completed' } });
  });

  it('single-flights concurrent sync and throttles the next scan', async () => {
    const first = service.sync(principal('user-a', walletA));
    const second = service.sync(principal('user-a', walletA));
    const [firstSummary, secondSummary] = await Promise.all([first, second]);
    expect(firstSummary.status).toBe('synced');
    expect(secondSummary).toEqual(firstSummary);

    await expect(
      service.sync(principal('user-a', walletA)),
    ).resolves.toMatchObject({ status: 'throttled', pagesScanned: 0 });
  });

  it('reports the Mainnet source on every sync summary', async () => {
    await expect(service.sync(principal('user-a', walletA))).resolves.toMatchObject({
      source: 'external_wallet',
      status: 'synced',
    });
  });
});
