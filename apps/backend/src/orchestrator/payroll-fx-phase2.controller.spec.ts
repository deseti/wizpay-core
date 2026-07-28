import { CircleService } from '../adapters/circle.service';
import { PayrollFxSettlementService } from '../agents/payroll/payroll-fx-settlement.service';
import { AppWalletSwapDepositVerifierService } from '../app-wallet-swap/app-wallet-swap-deposit-verifier.service';
import { PayrollFxStablefxLifecycleService } from '../payroll-fx/payroll-fx-stablefx-lifecycle.service';
import { TaskEmployeeBreakdownService } from '../task/task-employee-breakdown.service';
import { TaskPayrollHistoryService } from '../task/task-payroll-history.service';
import { TaskService } from '../task/task.service';
import { OrchestratorService } from './orchestrator.service';
import { PayrollInitService } from './payroll-init.service';
import { TaskController } from './task.controller';

describe('TaskController Payroll FX Phase 2 payout persistence', () => {
  const operationId = '8d00c7ac-d036-4448-94ea-2f38a51e64d8';
  const wallet = '0x1111111111111111111111111111111111111111';
  const treasury = '0x2222222222222222222222222222222222222222';
  const fundingHash = `0x${'a'.repeat(64)}`;
  const settlementHash = `0x${'b'.repeat(64)}`;
  const payoutHash = `0x${'c'.repeat(64)}`;
  const originalTreasury = process.env.CIRCLE_WALLET_ADDRESS_ARC;

  let events: string[];
  let circle: {
    transfer: jest.Mock;
    waitForTransactionComplete: jest.Mock;
  };
  let lifecycle: {
    recordPayoutSubmission: jest.Mock;
    recordPayoutCompletion: jest.Mock;
    recordPayoutFailure: jest.Mock;
  };
  let controller: TaskController;

  beforeEach(() => {
    process.env.CIRCLE_WALLET_ADDRESS_ARC = treasury;
    events = [];
    circle = {
      transfer: jest.fn(() => {
        events.push('payout');
        return { txId: 'payout-transaction-id', txHash: null };
      }),
      waitForTransactionComplete: jest.fn(() => {
        events.push('confirm_payout');
        return { txHash: payoutHash, status: 'COMPLETE' };
      }),
    };
    lifecycle = {
      recordPayoutSubmission: jest.fn(() => {
        events.push('record_payout_submission');
      }),
      recordPayoutCompletion: jest.fn(() => {
        events.push('record_completion');
      }),
      recordPayoutFailure: jest.fn(() => {
        events.push('record_payout_failure');
      }),
    };
    controller = new TaskController(
      {} as OrchestratorService,
      { createPayrollTask: jest.fn() } as unknown as TaskService,
      {} as TaskEmployeeBreakdownService,
      {} as TaskPayrollHistoryService,
      { prepare: jest.fn() } as unknown as PayrollInitService,
      circle as unknown as CircleService,
      {
        settle: jest.fn(() => {
          events.push('settlement');
          return {
            sourceToken: 'USDC',
            targetToken: 'EURC',
            sourceAmount: '30600000',
            targetAmount: '29750001',
            txHash: settlementHash,
            status: 'settled',
            operationId,
          };
        }),
      } as unknown as PayrollFxSettlementService,
      {
        verifyDeposit: jest.fn(() => {
          events.push('verify_deposit');
          return { confirmed: true, confirmedAmount: '30600000' };
        }),
      } as unknown as AppWalletSwapDepositVerifierService,
      lifecycle as unknown as PayrollFxStablefxLifecycleService,
    );
  });

  afterAll(() => {
    if (originalTreasury === undefined) {
      delete process.env.CIRCLE_WALLET_ADDRESS_ARC;
    } else {
      process.env.CIRCLE_WALLET_ADDRESS_ARC = originalTreasury;
    }
  });

  it('records payout submission and completes only after current confirmation', async () => {
    const response = await controller.settlePayrollFx({
      sourceToken: 'USDC',
      targetToken: 'EURC',
      sourceAmount: '30600000',
      referenceId: 'phase-2-payout',
      walletAddress: wallet,
      sourceFundingTxHash: fundingHash,
    });

    expect(events).toEqual([
      'verify_deposit',
      'settlement',
      'payout',
      'record_payout_submission',
      'confirm_payout',
      'record_completion',
    ]);
    expect(lifecycle.recordPayoutSubmission).toHaveBeenCalledWith(operationId, {
      transactionId: 'payout-transaction-id',
      transactionHash: null,
    });
    expect(lifecycle.recordPayoutCompletion).toHaveBeenCalledWith(
      operationId,
      expect.objectContaining({
        transactionId: 'payout-transaction-id',
        transactionHash: payoutHash,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        confirmedAt: expect.any(Date),
      }),
    );
    expect(response.data).not.toHaveProperty('operationId');
    expect(response.data).toMatchObject({
      payoutAmount: '29750001',
      payoutTxHash: payoutHash,
    });
  });

  it('preserves the payout error and never marks completion', async () => {
    const error = new Error('payout submission uncertain');
    circle.transfer.mockRejectedValue(error);

    await expect(
      controller.settlePayrollFx({
        sourceToken: 'USDC',
        targetToken: 'EURC',
        sourceAmount: '30600000',
        referenceId: 'phase-2-payout-failure',
        walletAddress: wallet,
        sourceFundingTxHash: fundingHash,
      }),
    ).rejects.toBe(error);
    expect(lifecycle.recordPayoutFailure).toHaveBeenCalledWith(
      operationId,
      error,
    );
    expect(lifecycle.recordPayoutSubmission).not.toHaveBeenCalled();
    expect(lifecycle.recordPayoutCompletion).not.toHaveBeenCalled();
  });

  it('keeps payout pending and records recovery evidence when confirmation fails', async () => {
    const error = new Error('payout confirmation uncertain');
    circle.waitForTransactionComplete.mockRejectedValue(error);

    await expect(
      controller.settlePayrollFx({
        sourceToken: 'USDC',
        targetToken: 'EURC',
        sourceAmount: '30600000',
        referenceId: 'phase-2-payout-confirmation-failure',
        walletAddress: wallet,
        sourceFundingTxHash: fundingHash,
      }),
    ).rejects.toBe(error);
    expect(lifecycle.recordPayoutSubmission).toHaveBeenCalledWith(operationId, {
      transactionId: 'payout-transaction-id',
      transactionHash: null,
    });
    expect(lifecycle.recordPayoutCompletion).not.toHaveBeenCalled();
    expect(lifecycle.recordPayoutFailure).toHaveBeenCalledWith(
      operationId,
      error,
    );
  });
});
