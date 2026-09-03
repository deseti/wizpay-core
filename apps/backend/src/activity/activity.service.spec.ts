/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await */
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ActivityService } from './activity.service';

const walletA = '0x1111111111111111111111111111111111111111' as const;
const walletB = '0x2222222222222222222222222222222222222222' as const;
const principal = (user: string, wallet: `0x${string}`) => ({
  merchantUserId: user,
  merchantWalletAddress: wallet,
  merchantDisplayLabel: null,
  circleWalletId: `wallet-${user}`,
  userToken: 'test-token',
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
      source: 'circle_w3s',
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
            .filter((row) => row.ownerUserId === where.ownerUserId)
            .slice(0, take),
        ),
        findFirst: jest.fn(
          async ({ where }: any) =>
            rows.find(
              (row) =>
                row.id === where.id && row.ownerUserId === where.ownerUserId,
            ) ?? null,
        ),
        update: jest.fn(async ({ where, data }: any) => {
          const row = rows.find((candidate) => candidate.id === where.id);
          Object.assign(row, data);
          return row;
        }),
      },
      appWalletXylonetOperation: { findMany: jest.fn(async () => []) },
      invoicePayment: { findMany: jest.fn(async () => []) },
      task: { findMany: jest.fn(async () => []) },
      bridgeTransaction: { findUnique: jest.fn(async () => null) },
      userWallet: {
        findMany: jest.fn(async () => [{ userId: 'user-a', address: walletA }]),
      },
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
    service = new ActivityService(prisma, {
      listUserTransactions: jest.fn(async () => ({ transactions: [] })),
      listUserTokenBalances: jest.fn(async () => ({ tokenBalances: [] })),
    } as never);
  });

  it('lists only the authenticated owner and a new user gets an empty page', async () => {
    await service.upsert({
      ownerUserId: 'user-a',
      walletAddress: walletA.toUpperCase().replace('0X', '0x'),
      type: 'send',
      direction: 'outgoing',
      status: 'submitted',
      source: 'circle_w3s',
      idempotencyKey: 'circle:1',
      sourceReferenceType: 'circle_transaction',
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

  it('keeps GET-style list reads database-only when Circle is unavailable', async () => {
    const w3s = {
      listUserTransactions: jest.fn(async () => {
        throw new Error('Circle unavailable');
      }),
    };
    service = new ActivityService(prisma, w3s as never);
    await service.upsert({
      ownerUserId: 'user-a',
      walletAddress: walletA,
      type: 'send',
      status: 'completed',
      source: 'circle_w3s',
      idempotencyKey: 'circle:stored',
      sourceReferenceType: 'circle_transaction',
      sourceReferenceId: 'stored',
    });
    await expect(
      service.list(principal('user-a', walletA), {}),
    ).resolves.toMatchObject({ items: [{ sourceReferenceId: 'stored' }] });
    expect(w3s.listUserTransactions).not.toHaveBeenCalled();
    expect(prisma.activity.upsert).toHaveBeenCalledTimes(1);
  });

  it('issues a 256-bit opaque read session bound to the canonical owner and never returns the Circle bearer', async () => {
    const result = await service.sync(principal('user-a', walletA));
    expect(result.readSessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.readSessionToken).not.toBe('test-token');
    expect(JSON.stringify(result)).not.toContain('test-token');
    const write = prisma.activityAuthSession.create.mock.calls[0][0];
    expect(write.data.sessionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(write)).not.toContain(result.readSessionToken);
    await expect(
      service.authenticateRead(`Bearer ${result.readSessionToken}`),
    ).resolves.toEqual({
      merchantUserId: 'user-a',
      merchantWalletAddress: walletA,
    });
  });

  it('rotates sessions, enforces expiry, and keeps User B from resolving as User A', async () => {
    const first = await service.sync(principal('user-a', walletA));
    const second = await service.sync(principal('user-a', walletA));
    expect(second.readSessionToken).not.toBe(first.readSessionToken);
    await expect(
      service.authenticateRead(`Bearer ${first.readSessionToken}`),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      service.authenticateRead(`Bearer ${second.readSessionToken}`),
    ).resolves.toMatchObject({ merchantUserId: 'user-a' });

    prisma.activitySyncState.upsert.mockImplementation(async ({ where }: any) => ({
      id: 'sync-user-b',
      ownerUserId: where.ownerUserId_source.ownerUserId,
      walletAddress: walletB,
      source: 'circle_w3s',
      checkpointTransactionId: null,
      leaseId: null,
      leaseExpiresAt: null,
      nextAllowedAt: null,
    }));
    const userB = await service.sync(principal('user-b', walletB));
    await expect(
      service.authenticateRead(`Bearer ${userB.readSessionToken}`),
    ).resolves.toMatchObject({ merchantUserId: 'user-b' });
    await expect(
      service.getOwned(
        { merchantUserId: 'user-b', merchantWalletAddress: walletB },
        'activity-1',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    prisma.activityAuthSession.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.authenticateRead(`Bearer ${userB.readSessionToken}`),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns not found when User B guesses User A activity ID', async () => {
    await service.upsert({
      ownerUserId: 'user-a',
      walletAddress: walletA,
      type: 'swap',
      status: 'pending',
      source: 'xylonet_tower',
      idempotencyKey: 'xylonet:1',
      sourceReferenceType: 'app_wallet_xylonet_operation',
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
      source: 'xylonet_tower',
      idempotencyKey: 'xylonet:1',
      sourceReferenceType: 'app_wallet_xylonet_operation',
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
      source: 'circle_w3s',
      idempotencyKey: 'circle:recoverable',
      sourceReferenceType: 'circle_transaction',
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
      source: 'circle_w3s',
      idempotencyKey: 'circle:1',
      sourceReferenceType: 'circle_transaction',
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
    expect(JSON.stringify(dto)).not.toContain('test-token');
    expect(JSON.stringify(dto)).not.toMatch(
      /credential|signature|typedData|permit2|providerResponse/i,
    );
  });

  it('does not grant task ownership from recipient or destination fields', async () => {
    prisma.task.findMany.mockResolvedValueOnce([
      {
        id: 'task-1',
        type: 'payroll',
        status: 'executed',
        metadata: {},
        payload: { recipient: walletA, destinationAddress: walletA },
        transactions: [{ status: 'completed', txHash: `0x${'b'.repeat(64)}` }],
        units: [],
        updatedAt: new Date(),
      },
    ]);
    await service.projectPersisted(principal('user-a', walletA));
    expect(rows).toHaveLength(0);
  });

  it('imports only Circle transfers bound to the authenticated canonical wallet', async () => {
    const w3s = {
      listUserTransactions: jest.fn(async () => ({
        transactions: [
          {
            id: 'out',
            operation: 'TRANSFER',
            walletId: 'wallet-user-a',
            blockchain: 'ARC-TESTNET',
            sourceAddress: walletA.toUpperCase().replace('0X', '0x'),
            destinationAddress: walletB,
            amounts: ['1.25'],
            tokenId: 'token-id',
            state: 'COMPLETE',
          },
          {
            id: 'in',
            operation: 'TRANSFER',
            walletId: 'wallet-user-a',
            blockchain: 'ARC-TESTNET',
            sourceAddress: walletB,
            destinationAddress: walletA,
            amounts: ['2'],
            tokenId: 'token-id',
            state: 'CONFIRMED',
          },
          {
            id: 'foreign',
            operation: 'TRANSFER',
            walletId: 'wallet-user-a',
            sourceAddress: walletB,
            destinationAddress: '0x3333333333333333333333333333333333333333',
            amounts: ['9'],
          },
        ],
      })),
    };
    service = new ActivityService(prisma, w3s as never);
    await service.sync(principal('user-a', walletA));
    expect(rows.map((row) => row.type)).toEqual(['send', 'receive']);
    expect(rows.map((row) => row.ownerUserId)).toEqual(['user-a', 'user-a']);
    expect(rows[0].inputAmount).toBe('1.25');
  });

  it('single-flights concurrent sync and throttles the next provider scan', async () => {
    let release!: () => void;
    const w3s = {
      listUserTransactions: jest.fn(
        () =>
          new Promise<{ transactions: never[] }>((resolve) => {
            release = () => resolve({ transactions: [] });
          }),
      ),
    };
    service = new ActivityService(prisma, w3s as never);
    const first = service.sync(principal('user-a', walletA));
    const second = service.sync(principal('user-a', walletA));
    for (let attempt = 0; !release && attempt < 10; attempt += 1)
      await new Promise((resolve) => setImmediate(resolve));
    expect(release).toBeDefined();
    release();
    const [firstSummary, secondSummary] = await Promise.all([first, second]);
    expect(firstSummary.status).toBe('synced');
    expect(secondSummary).toEqual(firstSummary);
    expect(w3s.listUserTransactions).toHaveBeenCalledTimes(1);

    await expect(
      service.sync(principal('user-a', walletA)),
    ).resolves.toMatchObject({ status: 'throttled', pagesScanned: 0 });
    expect(w3s.listUserTransactions).toHaveBeenCalledTimes(1);
  });

  it('continues after the persisted checkpoint and deduplicates provider pages', async () => {
    prisma.activitySyncState.upsert.mockResolvedValueOnce({
      id: 'sync-1',
      ownerUserId: 'user-a',
      walletAddress: walletA,
      source: 'circle_w3s',
      checkpointTransactionId: 'known',
      leaseId: null,
      leaseExpiresAt: null,
      nextAllowedAt: null,
    });
    const duplicate = {
      id: 'new-id',
      operation: 'TRANSFER',
      walletId: 'wallet-user-a',
      blockchain: 'ARC-TESTNET',
      sourceAddress: walletA,
      destinationAddress: walletB,
      amounts: ['1'],
      state: 'COMPLETE',
      txHash: `0x${'D'.repeat(64)}`,
    };
    const w3s = {
      listUserTransactions: jest.fn(async () => ({
        transactions: [
          { ...duplicate, id: 'known' },
          duplicate,
          { ...duplicate },
        ],
      })),
    };
    service = new ActivityService(prisma, w3s as never);
    const summary = await service.sync(principal('user-a', walletA));
    expect(w3s.listUserTransactions).toHaveBeenCalledWith(
      { walletId: 'wallet-user-a', pageAfter: 'known' },
      'test-token',
    );
    expect(summary).toMatchObject({
      recordsScanned: 3,
      recordsAccepted: 1,
      checkpointAdvanced: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      transactionId: 'new-id',
      txHash: `0x${'d'.repeat(64)}`,
    });
  });

  it('stores only a one-way read-session fingerprint, never the Circle token', async () => {
    const w3s = {
      listUserTransactions: jest.fn(async () => ({ transactions: [] })),
    };
    service = new ActivityService(prisma, w3s as never);
    await service.sync(principal('user-a', walletA));
    const write = prisma.activityAuthSession.create.mock.calls[0][0];
    expect(write.data.sessionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(write)).not.toContain('test-token');
  });

  it('projects a Circle-proven payroll once and does not duplicate its transfers as Sends', async () => {
    const txHash = `0x${'c'.repeat(64)}`;
    prisma.task.findMany.mockImplementation(async ({ where }: any) =>
      where.type === 'payroll'
        ? [
            {
              id: 'payroll-1',
              type: 'payroll',
              status: 'executed',
              metadata: { walletAddress: walletA, totalAmount: '1000000' },
              payload: {},
              transactions: [
                {
                  txId: 'payroll-tx',
                  status: 'completed',
                  txHash,
                },
              ],
              units: [],
              updatedAt: new Date('2026-08-31T00:00:00Z'),
            },
          ]
        : [],
    );
    service = new ActivityService(prisma, {
      listUserTransactions: jest.fn(async () => ({
        transactions: [
          {
            id: 'payroll-tx',
            operation: 'TRANSFER',
            walletId: 'wallet-user-a',
            blockchain: 'ARC-TESTNET',
            sourceAddress: walletA,
            destinationAddress: walletB,
            amounts: ['1'],
            state: 'COMPLETE',
          },
        ],
      })),
    } as never);
    await service.sync(principal('user-a', walletA));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'payroll', taskId: 'payroll-1' });
  });
});
