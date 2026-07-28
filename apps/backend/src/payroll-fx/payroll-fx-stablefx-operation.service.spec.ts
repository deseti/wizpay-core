import { ConflictException } from '@nestjs/common';
import { buildPayrollFxSafeFailure } from './payroll-fx-diagnostics';
import { buildPayrollFxOperationIdempotencyKey } from './payroll-fx-idempotency';
import { PayrollFxOperationIntentConflictError } from './payroll-fx-operation.errors';
import { PayrollFxOperationRepository } from './payroll-fx-operation.repository';
import type { PayrollFxOperation } from './payroll-fx-operation.types';
import { PayrollFxStablefxOperationService } from './payroll-fx-stablefx-operation.service';

const OPERATION_ID = '8d00c7ac-d036-4448-94ea-2f38a51e64d8';
const TREASURY = '0x2222222222222222222222222222222222222222';
const WALLET = '0x1111111111111111111111111111111111111111';
const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0x89b50855aa3be2f677cd6303cec089b5f319d72a';

function operation(status: PayrollFxOperation['status']): PayrollFxOperation {
  return {
    operationId: OPERATION_ID,
    idempotencyKey: 'key',
    taskId: null,
    walletMode: 'app',
    executionProvider: 'stablefx',
    sourceTokenAddress: USDC,
    destinationTokenAddress: EURC,
    sourceTokenSymbol: 'USDC',
    destinationTokenSymbol: 'EURC',
    network: 'ARC-TESTNET',
    sourceWalletAddress: WALLET,
    treasuryWalletAddress: TREASURY,
    amountInBaseUnits: '900719925474099312345678',
    requestedMinimumOutputBaseUnits: null,
    status,
    failureCode: null,
    failureMessage: null,
    quoteId: null,
    quoteExpiresAt: null,
    expectedOutputBaseUnits: null,
    actualOutputBaseUnits: null,
    providerOperationId: null,
    approvalTransactionId: null,
    approvalTransactionHash: null,
    fundingTransactionId: null,
    fundingTransactionHash: null,
    settlementTransactionId: null,
    settlementTransactionHash: null,
    payoutTransactionId: null,
    payoutTransactionHash: null,
    lastProviderStatus: null,
    diagnosticSnapshot: null,
    submittedAt: null,
    fundingConfirmedAt: null,
    settledAt: null,
    payoutConfirmedAt: null,
    completedAt: null,
    createdAt: new Date('2026-07-27T08:00:00.000Z'),
    updatedAt: new Date('2026-07-27T08:00:00.000Z'),
  };
}

function repositoryMock() {
  return {
    createOrGetByIdempotencyKey: jest.fn(),
    markQuotePending: jest.fn(),
    findById: jest.fn(),
    recordFailure: jest.fn(),
    recordQuote: jest.fn(),
    recordApproval: jest.fn(),
    recordSubmission: jest.fn(),
    recordFunding: jest.fn(),
    recordSettlement: jest.fn(),
    recordPayoutSubmission: jest.fn(),
    recordPayout: jest.fn(),
  };
}

describe('PayrollFxStablefxOperationService', () => {
  const request = {
    sourceToken: 'USDC',
    targetToken: 'EURC',
    sourceAmount: '900719925474099312345678',
    referenceId: 'payroll-run-42',
    walletAddress: WALLET,
  };

  it('builds a deterministic, scoped, secret-free idempotency key', () => {
    const first = buildPayrollFxOperationIdempotencyKey(' payroll-run-42 ');
    const second = buildPayrollFxOperationIdempotencyKey('payroll-run-42');

    expect(first).toBe(second);
    expect(first).toMatch(/^payroll-fx:app:stablefx:[a-f0-9]{64}$/);
    expect(first).not.toContain('payroll-run-42');
  });

  it('persists exact immutable intent and atomically claims quote_pending', async () => {
    const repository = repositoryMock();
    repository.createOrGetByIdempotencyKey.mockResolvedValue(
      operation('created'),
    );
    repository.markQuotePending.mockResolvedValue(operation('quote_pending'));
    const service = new PayrollFxStablefxOperationService(
      repository as unknown as PayrollFxOperationRepository,
    );

    await expect(
      service.begin(request, TREASURY, USDC, EURC),
    ).resolves.toMatchObject({
      operationId: OPERATION_ID,
      status: 'quote_pending',
    });
    expect(repository.createOrGetByIdempotencyKey).toHaveBeenCalledWith({
      idempotencyKey: buildPayrollFxOperationIdempotencyKey(
        request.referenceId,
      ),
      walletMode: 'app',
      executionProvider: 'stablefx',
      sourceTokenAddress: USDC,
      destinationTokenAddress: EURC,
      sourceTokenSymbol: 'USDC',
      destinationTokenSymbol: 'EURC',
      network: 'ARC-TESTNET',
      sourceWalletAddress: WALLET,
      treasuryWalletAddress: TREASURY,
      amountInBaseUnits: '900719925474099312345678',
      requestedMinimumOutputBaseUnits: null,
    });
    expect(repository.markQuotePending).toHaveBeenCalledWith(OPERATION_ID);
  });

  it('does not resubmit an equivalent operation that already started', async () => {
    const repository = repositoryMock();
    repository.createOrGetByIdempotencyKey.mockResolvedValue(
      operation('submitted'),
    );
    const service = new PayrollFxStablefxOperationService(
      repository as unknown as PayrollFxOperationRepository,
    );

    await expect(
      service.begin(request, TREASURY, USDC, EURC),
    ).rejects.toMatchObject({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      response: expect.objectContaining({
        code: 'PAYROLL_FX_OPERATION_ALREADY_STARTED',
      }),
    });
    expect(repository.markQuotePending).not.toHaveBeenCalled();
  });

  it('preserves the Phase 1 immutable-intent conflict', async () => {
    const repository = repositoryMock();
    const conflict = new PayrollFxOperationIntentConflictError('key', [
      'amountInBaseUnits',
    ]);
    repository.createOrGetByIdempotencyKey.mockRejectedValue(conflict);
    const service = new PayrollFxStablefxOperationService(
      repository as unknown as PayrollFxOperationRepository,
    );

    await expect(service.begin(request, TREASURY, USDC, EURC)).rejects.toBe(
      conflict,
    );
    expect(repository.markQuotePending).not.toHaveBeenCalled();
  });

  it('classifies pre-side-effect failure as failed and post-boundary failure as recovery_required', async () => {
    const repository = repositoryMock();
    repository.findById
      .mockResolvedValueOnce(operation('quote_pending'))
      .mockResolvedValueOnce(operation('submitted'));
    const service = new PayrollFxStablefxOperationService(
      repository as unknown as PayrollFxOperationRepository,
    );

    await service.recordFailureSafely(
      OPERATION_ID,
      new Error('quote unavailable'),
      'tradable_quote',
      false,
    );
    await service.recordFailureSafely(
      OPERATION_ID,
      new Error('funding uncertain'),
      'fund',
      true,
    );

    expect(repository.recordFailure).toHaveBeenNthCalledWith(
      1,
      OPERATION_ID,
      'quote_pending',
      expect.objectContaining({ status: 'failed' }),
    );
    expect(repository.recordFailure).toHaveBeenNthCalledWith(
      2,
      OPERATION_ID,
      'submitted',
      expect.objectContaining({ status: 'recovery_required' }),
    );
  });

  it('maps every current lifecycle boundary to the Phase 1 repository transition', async () => {
    const repository = repositoryMock();
    const service = new PayrollFxStablefxOperationService(
      repository as unknown as PayrollFxOperationRepository,
    );
    const now = new Date('2026-07-27T08:30:00.000Z');

    await service.recordQuote(OPERATION_ID, {
      quoteId: 'quote-id',
      expectedOutputBaseUnits: '29750001',
    });
    await service.recordApproval(OPERATION_ID, {
      approvalTransactionId: 'approval-id',
    });
    await service.recordSubmission(OPERATION_ID, 'approval_pending', {
      providerOperationId: 'trade-id',
      submittedAt: now,
    });
    await service.recordFunding(OPERATION_ID, {
      fundingTransactionId: 'funding-id',
      fundingConfirmedAt: now,
    });
    await service.recordSettlement(OPERATION_ID, {
      actualOutputBaseUnits: '29750001',
      settlementTransactionHash: `0x${'a'.repeat(64)}`,
      settledAt: now,
    });
    await service.recordPayoutSubmission(OPERATION_ID, {
      transactionId: 'payout-id',
      transactionHash: null,
    });
    await service.recordPayoutCompletion(OPERATION_ID, {
      transactionId: 'payout-id',
      transactionHash: `0x${'b'.repeat(64)}`,
      confirmedAt: now,
    });

    expect(repository.recordQuote).toHaveBeenCalledWith(
      OPERATION_ID,
      'quote_pending',
      expect.objectContaining({ quoteId: 'quote-id' }),
    );
    expect(repository.recordApproval).toHaveBeenCalledWith(
      OPERATION_ID,
      expect.objectContaining({ approvalTransactionId: 'approval-id' }),
    );
    expect(repository.recordSubmission).toHaveBeenCalledWith(
      OPERATION_ID,
      'approval_pending',
      expect.objectContaining({ providerOperationId: 'trade-id' }),
    );
    expect(repository.recordFunding).toHaveBeenCalledWith(
      OPERATION_ID,
      'submitted',
      expect.objectContaining({ fundingTransactionId: 'funding-id' }),
    );
    expect(repository.recordSettlement).toHaveBeenCalledWith(
      OPERATION_ID,
      'settlement_pending',
      expect.objectContaining({ actualOutputBaseUnits: '29750001' }),
    );
    expect(repository.recordPayoutSubmission).toHaveBeenCalledWith(
      OPERATION_ID,
      expect.objectContaining({ payoutTransactionId: 'payout-id' }),
    );
    expect(repository.recordPayout).toHaveBeenCalledWith(
      OPERATION_ID,
      'payout_pending',
      expect.objectContaining({
        payoutTransactionId: 'payout-id',
        payoutTransactionHash: `0x${'b'.repeat(64)}`,
        completedAt: now,
      }),
    );
  });

  it('stores bounded diagnostics without secret-bearing provider fields', () => {
    const secret = 'Bearer super-secret-token';
    const safe = buildPayrollFxSafeFailure(
      {
        response: {
          data: { authorization: secret, typedData: { signature: secret } },
        },
        message: `provider failed ${secret} ${'x'.repeat(2_000)}`,
      },
      'create_trade',
    );
    const serialized = JSON.stringify(safe);

    expect(serialized.length).toBeLessThan(1_000);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('typedData');
  });

  it('uses a bounded conflict response instead of exposing repository state', async () => {
    const repository = repositoryMock();
    repository.createOrGetByIdempotencyKey.mockResolvedValue(
      operation('settlement_pending'),
    );
    const service = new PayrollFxStablefxOperationService(
      repository as unknown as PayrollFxOperationRepository,
    );

    const error = await service
      .begin(request, TREASURY, USDC, EURC)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect(JSON.stringify(error)).not.toContain('super-secret');
  });
});
