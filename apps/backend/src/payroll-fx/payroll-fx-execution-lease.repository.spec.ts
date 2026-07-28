/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { PayrollFxExecutionLeaseRepository } from './payroll-fx-execution-lease.repository';

describe('PayrollFxExecutionLeaseRepository', () => {
  const now = new Date('2026-07-27T10:00:00.000Z');
  const clock = { now: jest.fn(() => now) };
  const updateMany = jest.fn();
  const findUniqueOrThrow = jest.fn();
  const prisma = {
    payrollFxOperation: { updateMany, findUniqueOrThrow },
  };
  const repository = new PayrollFxExecutionLeaseRepository(
    prisma as never,
    clock,
  );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('atomically acquires, increments the attempt once, and uses expiry CAS', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findUniqueOrThrow.mockResolvedValue({ executionAttemptCount: 4 });

    const lease = await repository.acquire('operation-id', 60_000, 'lease-a');

    expect(lease).toEqual({
      operationId: 'operation-id',
      leaseId: 'lease-a',
      expiresAt: new Date('2026-07-27T10:01:00.000Z'),
      attemptCount: 4,
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          operationId: 'operation-id',
          OR: expect.arrayContaining([
            { executionLeaseId: null },
            { executionLeaseExpiresAt: { lte: now } },
          ]),
        }),
        data: expect.objectContaining({
          executionAttemptCount: { increment: 1 },
          lastAttemptStartedAt: now,
        }),
      }),
    );
  });

  it('has exactly one winner for concurrent acquisition', async () => {
    updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    findUniqueOrThrow.mockResolvedValue({ executionAttemptCount: 1 });

    const [first, second] = await Promise.all([
      repository.acquire('operation-id', 60_000, 'lease-a'),
      repository.acquire('operation-id', 60_000, 'lease-b'),
    ]);

    expect(first?.leaseId).toBe('lease-a');
    expect(second).toBeNull();
    expect(findUniqueOrThrow).toHaveBeenCalledTimes(1);
  });

  it('renews only a current unexpired owner', async () => {
    updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const lease = {
      operationId: 'operation-id',
      leaseId: 'lease-a',
      expiresAt: new Date('2026-07-27T10:01:00.000Z'),
      attemptCount: 1,
    };

    await expect(repository.renew(lease, 120_000)).resolves.toEqual({
      ...lease,
      expiresAt: new Date('2026-07-27T10:02:00.000Z'),
    });
    await expect(repository.renew(lease, 120_000)).resolves.toBeNull();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          executionLeaseId: 'lease-a',
          executionLeaseExpiresAt: { gt: now },
        }),
      }),
    );
  });

  it('releases only a current unexpired owner and records attempt finish', async () => {
    updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const lease = {
      operationId: 'operation-id',
      leaseId: 'lease-a',
      expiresAt: new Date('2026-07-27T10:01:00.000Z'),
      attemptCount: 1,
    };

    await expect(repository.release(lease)).resolves.toBe(true);
    await expect(repository.release(lease)).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          executionLeaseId: null,
          executionLeaseExpiresAt: null,
          lastAttemptFinishedAt: now,
        },
      }),
    );
  });
});
