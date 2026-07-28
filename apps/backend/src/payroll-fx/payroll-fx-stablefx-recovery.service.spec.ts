import type { PayrollFxOperation } from './payroll-fx-operation.types';
import { PayrollFxStablefxRecoveryService } from './payroll-fx-stablefx-recovery.service';

describe('PayrollFxStablefxRecoveryService', () => {
  const operationId = '8d00c7ac-d036-4448-94ea-2f38a51e64d8';
  const request = {
    sourceToken: 'USDC',
    targetToken: 'EURC',
    sourceAmount: '30000000',
    referenceId: 'phase-3-recovery',
    walletAddress: '0x1111111111111111111111111111111111111111',
  };
  const treasury = '0x2222222222222222222222222222222222222222';
  const operations = {
    findByIdempotencyKey: jest.fn(),
    findById: jest.fn(),
    recordFailure: jest.fn(),
    resumeFromRecovery: jest.fn(),
    retryFailedQuote: jest.fn(),
    reconcileApprovalToQuoteReady: jest.fn(),
    markPayoutPending: jest.fn(),
    recordPayoutSubmission: jest.fn(),
    recordPayout: jest.fn(),
  };
  const operationService = { createOrGet: jest.fn() };
  const leases = {
    acquire: jest.fn(),
    release: jest.fn(),
  };
  const reconciler = {
    reconcileApproval: jest.fn(),
    readTrade: jest.fn(),
    fundingIsProven: jest.fn(),
    readPayout: jest.fn(),
  };
  const lifecycle = {
    settlePersisted: jest.fn(),
    resumeSubmitted: jest.fn(),
    recordReconciledFunding: jest.fn(),
    resumeSettlement: jest.fn(),
  };
  const circle = { transfer: jest.fn() };
  const policy = {
    leaseDurationMs: jest.fn(() => 300_000),
    maxPreSideEffectAttempts: 3,
    isTransientPreSideEffect: jest.fn(() => true),
  };

  const service = new PayrollFxStablefxRecoveryService(
    operations as never,
    operationService as never,
    leases as never,
    reconciler as never,
    lifecycle as never,
    circle as never,
    policy as never,
  );

  function operation(
    status: PayrollFxOperation['status'],
    overrides: Partial<PayrollFxOperation> = {},
  ): PayrollFxOperation {
    return {
      operationId,
      idempotencyKey: 'key',
      taskId: null,
      walletMode: 'app',
      executionProvider: 'stablefx',
      sourceTokenAddress: '0x3600000000000000000000000000000000000000',
      destinationTokenAddress: '0x3600000000000000000000000000000000000001',
      sourceTokenSymbol: 'USDC',
      destinationTokenSymbol: 'EURC',
      network: 'ARC-TESTNET',
      sourceWalletAddress: request.walletAddress,
      treasuryWalletAddress: treasury,
      amountInBaseUnits: request.sourceAmount,
      requestedMinimumOutputBaseUnits: null,
      status,
      failureCode: null,
      failureMessage: null,
      quoteId: null,
      quoteExpiresAt: null,
      expectedOutputBaseUnits: '29700000',
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
      approvalTargetAddress: '0x3333333333333333333333333333333333333333',
      lastProviderStatus: null,
      diagnosticSnapshot: null,
      executionLeaseId: null,
      executionLeaseExpiresAt: null,
      executionAttemptCount: 1,
      lastAttemptStartedAt: null,
      lastAttemptFinishedAt: null,
      recoveryFromStatus: null,
      submittedAt: null,
      fundingConfirmedAt: null,
      settledAt: null,
      payoutConfirmedAt: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    leases.acquire.mockResolvedValue({
      operationId,
      leaseId: 'lease-id',
      expiresAt: new Date(Date.now() + 300_000),
      attemptCount: 1,
    });
    leases.release.mockResolvedValue(true);
  });

  async function settle(current: PayrollFxOperation) {
    operations.findByIdempotencyKey.mockResolvedValue(current);
    operations.findById.mockResolvedValue(current);
    return service.settle(request, treasury);
  }

  it('returns completed evidence as a no-op', async () => {
    const current = operation('completed', {
      actualOutputBaseUnits: '29700000',
      settlementTransactionHash: `0x${'a'.repeat(64)}`,
    });

    await expect(settle(current)).resolves.toMatchObject({
      operationId,
      status: 'settled',
    });
    expect(reconciler.readTrade).not.toHaveBeenCalled();
    expect(lifecycle.settlePersisted).not.toHaveBeenCalled();
  });

  it('uses a persisted trade ID for lookup and never creates a new operation', async () => {
    const current = operation('submitted', {
      providerOperationId: 'trade-id',
    });
    const trade = { id: 'trade-id', contractTradeId: 'contract-id' };
    reconciler.readTrade.mockResolvedValue(trade);
    lifecycle.resumeSubmitted.mockResolvedValue({
      status: 'settled',
      operationId,
    });

    await settle(current);

    expect(reconciler.readTrade).toHaveBeenCalledWith(current);
    expect(lifecycle.resumeSubmitted).toHaveBeenCalled();
    expect(operationService.createOrGet).not.toHaveBeenCalled();
  });

  it('fails closed when createTrade may have succeeded without a durable ID', async () => {
    const current = operation('submitted');
    operations.recordFailure.mockResolvedValue(operation('recovery_required'));

    await expect(settle(current)).rejects.toMatchObject({
      response: { code: 'PAYROLL_FX_RECOVERY_REQUIRED' },
    });
    expect(operations.recordFailure).toHaveBeenCalledWith(
      operationId,
      'submitted',
      expect.objectContaining({
        failureCode: 'PAYROLL_FX_TRADE_ID_MISSING',
      }),
      { leaseId: 'lease-id' },
    );
    expect(reconciler.readTrade).not.toHaveBeenCalled();
    expect(lifecycle.resumeSubmitted).not.toHaveBeenCalled();
  });

  it('reconciles allowance before continuing an approval-pending operation', async () => {
    const current = operation('approval_pending', {
      approvalTransactionId: 'approval-id',
    });
    const quoteReady = operation('quote_ready');
    reconciler.reconcileApproval.mockResolvedValue({
      allowanceSufficient: true,
      transaction: { status: 'COMPLETE' },
    });
    operations.reconcileApprovalToQuoteReady.mockResolvedValue(quoteReady);
    lifecycle.settlePersisted.mockResolvedValue({ status: 'settled' });

    await settle(current);

    expect(reconciler.reconcileApproval).toHaveBeenCalledWith(current);
    expect(lifecycle.settlePersisted).toHaveBeenCalledWith(
      request,
      treasury,
      quoteReady,
      { leaseId: 'lease-id' },
    );
  });

  it('recovers an approval crash without an ID when allowance proves completion', async () => {
    const current = operation('approval_pending');
    const quoteReady = operation('quote_ready');
    reconciler.reconcileApproval.mockResolvedValue({
      allowanceSufficient: true,
      transaction: null,
    });
    operations.reconcileApprovalToQuoteReady.mockResolvedValue(quoteReady);
    lifecycle.settlePersisted.mockResolvedValue({ status: 'settled' });

    await settle(current);

    expect(operations.reconcileApprovalToQuoteReady).toHaveBeenCalled();
    expect(lifecycle.settlePersisted).toHaveBeenCalled();
  });

  it('does not repeat ambiguous funding', async () => {
    const current = operation('funding_pending', {
      providerOperationId: 'trade-id',
    });
    reconciler.readTrade.mockResolvedValue({ status: 'awaiting_funding' });
    reconciler.fundingIsProven.mockReturnValue(false);
    operations.recordFailure.mockResolvedValue(operation('recovery_required'));

    await expect(settle(current)).rejects.toMatchObject({
      response: { code: 'PAYROLL_FX_RECOVERY_REQUIRED' },
    });
    expect(lifecycle.recordReconciledFunding).not.toHaveBeenCalled();
    expect(lifecycle.resumeSubmitted).not.toHaveBeenCalled();
  });

  it('settlement_pending performs read-only settlement continuation', async () => {
    const current = operation('settlement_pending', {
      providerOperationId: 'trade-id',
    });
    lifecycle.resumeSettlement.mockResolvedValue({ status: 'settled' });

    await settle(current);

    expect(lifecycle.resumeSettlement).toHaveBeenCalledWith(request, current, {
      leaseId: 'lease-id',
    });
    expect(reconciler.readTrade).not.toHaveBeenCalled();
  });

  it('reconciles persisted payout evidence without another transfer', async () => {
    const current = operation('payout_pending', {
      payoutTransactionId: 'payout-id',
    });
    operations.findById.mockResolvedValue(current);
    reconciler.readPayout.mockResolvedValue({
      txId: 'payout-id',
      txHash: `0x${'b'.repeat(64)}`,
      status: 'COMPLETE',
    });
    operations.recordPayout.mockResolvedValue(operation('completed'));

    await service.payout(operationId, {
      referenceId: request.referenceId,
      targetToken: 'EURC',
      walletAddress: request.walletAddress,
      payoutAmount: '29.7',
    });

    expect(reconciler.readPayout).toHaveBeenCalledWith('payout-id');
    expect(circle.transfer).not.toHaveBeenCalled();
  });

  it('marks payout pending before transfer and fails closed after a crash-like submission error', async () => {
    const settled = operation('settled');
    const payoutPending = operation('payout_pending');
    operations.findById.mockResolvedValue(settled);
    operations.markPayoutPending.mockResolvedValue(payoutPending);
    circle.transfer.mockRejectedValue(new Error('connection reset'));
    operations.recordFailure.mockResolvedValue(operation('recovery_required'));

    await expect(
      service.payout(operationId, {
        referenceId: request.referenceId,
        targetToken: 'EURC',
        walletAddress: request.walletAddress,
        payoutAmount: '29.7',
      }),
    ).rejects.toThrow('connection reset');

    expect(
      operations.markPayoutPending.mock.invocationCallOrder[0],
    ).toBeLessThan(circle.transfer.mock.invocationCallOrder[0]);
    expect(operations.recordFailure).toHaveBeenCalledWith(
      operationId,
      'payout_pending',
      expect.objectContaining({
        failureCode: 'PAYROLL_FX_PAYOUT_AMBIGUOUS',
      }),
      { leaseId: 'lease-id' },
    );
  });

  it('returns a bounded busy result when another worker owns the lease', async () => {
    const current = operation('created');
    operations.findByIdempotencyKey.mockResolvedValue(current);
    leases.acquire.mockResolvedValue(null);

    await expect(service.settle(request, treasury)).rejects.toMatchObject({
      response: { code: 'PAYROLL_FX_OPERATION_BUSY' },
    });
    expect(lifecycle.settlePersisted).not.toHaveBeenCalled();
  });

  it('retries a classified pre-side-effect transient failure within the durable bound', async () => {
    const current = operation('failed', {
      recoveryFromStatus: 'quote_pending',
      diagnosticSnapshot: { httpStatus: 503 },
      executionAttemptCount: 2,
    });
    const retry = operation('quote_pending', { executionAttemptCount: 2 });
    operations.retryFailedQuote.mockResolvedValue(retry);
    lifecycle.settlePersisted.mockResolvedValue({ status: 'settled' });

    await settle(current);

    expect(policy.isTransientPreSideEffect).toHaveBeenCalledWith(current);
    expect(operations.retryFailedQuote).toHaveBeenCalled();
    expect(lifecycle.settlePersisted).toHaveBeenCalled();
  });

  it('does not retry a permanent or exhausted failure', async () => {
    const permanent = operation('failed', {
      recoveryFromStatus: 'quote_pending',
      diagnosticSnapshot: { httpStatus: 400 },
      executionAttemptCount: 2,
    });
    policy.isTransientPreSideEffect.mockReturnValueOnce(false);
    await expect(settle(permanent)).rejects.toMatchObject({
      response: { code: 'PAYROLL_FX_RECOVERY_REQUIRED' },
    });

    const exhausted = operation('failed', {
      recoveryFromStatus: 'quote_pending',
      diagnosticSnapshot: { httpStatus: 503 },
      executionAttemptCount: 4,
    });
    await expect(settle(exhausted)).rejects.toMatchObject({
      response: { code: 'PAYROLL_FX_RECOVERY_REQUIRED' },
    });
    expect(operations.retryFailedQuote).not.toHaveBeenCalled();
  });

  it('fails closed for an unknown persisted provider before acquiring a lease', async () => {
    const current = operation('created', {
      executionProvider: 'unknown' as never,
    });
    operations.findByIdempotencyKey.mockResolvedValue(current);

    await expect(service.settle(request, treasury)).rejects.toMatchObject({
      response: { code: 'PAYROLL_FX_RECOVERY_PROVIDER_UNSUPPORTED' },
    });
    expect(leases.acquire).not.toHaveBeenCalled();
  });

  it('fails closed when the recovery request conflicts with immutable intent', async () => {
    const current = operation('created', {
      amountInBaseUnits: '40000000',
    });
    operations.findByIdempotencyKey.mockResolvedValue(current);

    await expect(service.settle(request, treasury)).rejects.toMatchObject({
      response: { code: 'PAYROLL_FX_OPERATION_INTENT_CONFLICT' },
    });
    expect(leases.acquire).not.toHaveBeenCalled();
  });
});
