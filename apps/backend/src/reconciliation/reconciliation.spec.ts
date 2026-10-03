import { ConflictException } from '@nestjs/common';
import { type ReconciliationWork } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  PostgresDeliveryService,
  RecoveryDeferred,
  RecoveryRejected,
} from './postgres-delivery.service';
import { RecoveryVerifierService } from './recovery-verifier.service';
import {
  ReconciliationService,
  recoveryFailure,
} from './reconciliation.service';

const work = {
  id: 'delivery',
  kind: 'SWAP',
  network: 'arc-mainnet',
  recordId: 'wallet',
  evidenceKey: `0x${'a'.repeat(64)}`,
  leaseToken: 'lease',
  leaseExpiresAt: new Date(Date.now() + 120_000),
  attempts: 1,
} as ReconciliationWork;
function fixture() {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
    reconciliationWork: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  const prisma = {
    $transaction: jest.fn((run: (client: typeof tx) => Promise<unknown>) =>
      run(tx),
    ),
  };
  const delivery = {
    assertNetwork: jest.fn(),
    claim: jest.fn().mockResolvedValueOnce(work).mockResolvedValue(null),
    commit: jest.fn().mockResolvedValue(undefined),
    retry: jest.fn().mockResolvedValue(undefined),
  };
  const verifier = {
    prepare: jest.fn().mockResolvedValue(() => Promise.resolve()),
  };
  return {
    service: new ReconciliationService(
      prisma as unknown as PrismaService,
      delivery as unknown as PostgresDeliveryService,
      verifier as unknown as RecoveryVerifierService,
    ),
    delivery,
    verifier,
  };
}

describe('bounded reconciliation batch', () => {
  afterEach(() => jest.useRealTimers());
  it('defers an observer that exceeds the budget and never applies its late result', async () => {
    jest.useFakeTimers();
    const { service, delivery, verifier } = fixture();
    let resolve!: (apply: () => Promise<void>) => void;
    verifier.prepare.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const run = service.runReconciliationBatch({ budgetMs: 10_000 });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(await run).toMatchObject({
      timedOut: 1,
      retried: 1,
      acknowledged: 0,
    });
    expect(delivery.retry).toHaveBeenCalledWith(work, 'RECOVERY_TIME_BUDGET');
    const apply = jest.fn().mockResolvedValue(undefined);
    resolve(apply);
    await Promise.resolve();
    expect(delivery.commit).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('never exposes driver diagnostics as stored/logged failure codes', async () => {
    const { service, delivery, verifier } = fixture();
    verifier.prepare.mockRejectedValue(
      new Error(
        'postgresql://private:password@database secret signing material',
      ),
    );
    const log = jest.spyOn(console, 'log');
    const error = jest.spyOn(console, 'error');
    try {
      expect(await service.runReconciliationBatch()).toMatchObject({
        retried: 1,
      });
      expect(delivery.retry).toHaveBeenCalledWith(
        work,
        'RECOVERY_TRANSIENT_ERROR',
      );
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('keeps failed durable commits retryable and never counts them as acknowledged', async () => {
    const { service, delivery } = fixture();
    delivery.commit.mockRejectedValue(
      new RecoveryDeferred('RECOVERY_LEASE_LOST'),
    );
    expect(await service.runReconciliationBatch()).toMatchObject({
      retried: 1,
      acknowledged: 0,
    });
    expect(delivery.retry).toHaveBeenCalledWith(work, 'RECOVERY_LEASE_LOST');
  });

  it('does not process another delivery after the configured batch limit', async () => {
    const { service, delivery } = fixture();
    delivery.claim.mockReset().mockResolvedValue(work);
    expect(await service.runReconciliationBatch({ limit: 2 })).toMatchObject({
      claimed: 2,
      acknowledged: 2,
    });
    expect(delivery.claim).toHaveBeenCalledTimes(2);
  });

  it('uses only safe authoritative error classification', () => {
    expect(
      recoveryFailure(
        new ConflictException({
          code: 'PAYROLL_RECEIPT_MISMATCH',
          retryable: false,
        }),
      ),
    ).toMatchObject({ permanent: true, verificationMismatch: true });
    expect(
      recoveryFailure(new RecoveryRejected('RECOVERY_HASH_REQUIRED')),
    ).toMatchObject({ permanent: true });
    expect(
      recoveryFailure({ code: 'password://secret', retryable: true }),
    ).toMatchObject({ code: 'RECOVERY_TRANSIENT_ERROR', permanent: false });
    expect(
      recoveryFailure(new RecoveryDeferred('RECOVERY_INTENT_LEASE_ACTIVE')),
    ).toMatchObject({ permanent: false });
  });
});
