import { OrchestratorService } from './orchestrator.service';
import { PayrollInitService } from './payroll-init.service';
import { TaskController } from './task.controller';
import { TaskService } from '../task/task.service';
import { TaskEmployeeBreakdownService } from '../task/task-employee-breakdown.service';
import { TaskPayrollHistoryService } from '../task/task-payroll-history.service';
import { CircleService } from '../adapters/circle.service';
import { PayrollFxSettlementService } from '../agents/payroll/payroll-fx-settlement.service';
import { AppWalletSwapDepositVerifierService } from '../app-wallet-swap/app-wallet-swap-deposit-verifier.service';

describe('App Wallet payroll FX timing and persistence (characterization)', () => {
  const walletAddress = '0x1111111111111111111111111111111111111111';
  const treasuryAddress = '0x2222222222222222222222222222222222222222';
  const fundingTxHash = `0x${'a'.repeat(64)}`;
  const settlementTxHash = `0x${'b'.repeat(64)}`;
  const payoutTxHash = `0x${'c'.repeat(64)}`;
  const originalTreasuryAddress = process.env.CIRCLE_WALLET_ADDRESS_ARC;

  let calls: string[];
  let payrollInitService: { prepare: jest.Mock };
  let taskService: { createPayrollTask: jest.Mock };
  let circleService: {
    transfer: jest.Mock;
    waitForTransactionComplete: jest.Mock;
  };
  let settlementService: { settle: jest.Mock };
  let depositVerifier: { verifyDeposit: jest.Mock };
  let controller: TaskController;

  beforeEach(() => {
    process.env.CIRCLE_WALLET_ADDRESS_ARC = treasuryAddress;
    calls = [];
    payrollInitService = { prepare: jest.fn() };
    taskService = { createPayrollTask: jest.fn() };
    depositVerifier = {
      verifyDeposit: jest.fn(() => {
        calls.push('verify_deposit');
        return { confirmed: true, confirmedAmount: '30600000' };
      }),
    };
    settlementService = {
      settle: jest.fn(() => {
        calls.push('settle_fx');
        return {
          sourceToken: 'USDC',
          targetToken: 'EURC',
          sourceAmount: '30600000',
          targetAmount: '29750001',
          txHash: settlementTxHash,
          status: 'settled',
        };
      }),
    };
    circleService = {
      transfer: jest.fn(() => {
        calls.push('submit_payout');
        return { txId: 'payout-circle-id', txHash: null };
      }),
      waitForTransactionComplete: jest.fn(() => {
        calls.push('confirm_payout');
        return { txHash: payoutTxHash, status: 'COMPLETE' };
      }),
    };
    controller = new TaskController(
      {} as OrchestratorService,
      taskService as unknown as TaskService,
      {} as TaskEmployeeBreakdownService,
      {} as TaskPayrollHistoryService,
      payrollInitService as unknown as PayrollInitService,
      circleService as unknown as CircleService,
      settlementService as unknown as PayrollFxSettlementService,
      depositVerifier as unknown as AppWalletSwapDepositVerifierService,
    );
  });

  afterAll(() => {
    if (originalTreasuryAddress === undefined) {
      delete process.env.CIRCLE_WALLET_ADDRESS_ARC;
    } else {
      process.env.CIRCLE_WALLET_ADDRESS_ARC = originalTreasuryAddress;
    }
  });

  it('finishes deposit verification, FX settlement, and payout without creating a Payroll Task', async () => {
    const response = await controller.settlePayrollFx({
      sourceToken: 'USDC',
      targetToken: 'EURC',
      sourceAmount: '30600000',
      referenceId: 'payroll-fx-before-task',
      walletAddress,
      sourceFundingTxHash: fundingTxHash,
    });

    expect(calls).toEqual([
      'verify_deposit',
      'settle_fx',
      'submit_payout',
      'confirm_payout',
    ]);
    expect(payrollInitService.prepare).not.toHaveBeenCalled();
    expect(taskService.createPayrollTask).not.toHaveBeenCalled();
    expect(response.data).toEqual({
      sourceToken: 'USDC',
      targetToken: 'EURC',
      sourceAmount: '30600000',
      targetAmount: '29750001',
      txHash: settlementTxHash,
      status: 'settled',
      payoutTxHash,
      payoutAmount: '29750001',
      sourceFundingTxHash: fundingTxHash,
      sourceFundingAmount: '30600000',
      walletAddress,
    });
  });

  it('submits the settled base-unit output as a six-decimal human payout', async () => {
    await controller.settlePayrollFx({
      sourceToken: 'USDC',
      targetToken: 'EURC',
      sourceAmount: '30600000',
      referenceId: 'payroll-fx-payout-format',
      walletAddress,
      sourceFundingTxHash: fundingTxHash,
    });

    expect(circleService.transfer).toHaveBeenCalledWith({
      network: 'ARC-TESTNET',
      token: 'EURC',
      toAddress: walletAddress,
      amount: '29.750001',
      idempotencyKey: 'payroll-fx-payout-payroll-fx-payout-format',
    });
  });

  it('does not persist provider, quote, trade, funding, or settlement records in this controller path', async () => {
    const response = await controller.settlePayrollFx({
      sourceToken: 'USDC',
      targetToken: 'EURC',
      sourceAmount: '30600000',
      referenceId: 'payroll-fx-transient-evidence',
      walletAddress,
      sourceFundingTxHash: fundingTxHash,
    });

    for (const field of [
      'provider',
      'quoteId',
      'tradeId',
      'fundingId',
      'settlementStatus',
      'actualOutput',
    ]) {
      expect(response.data).not.toHaveProperty(field);
    }
  });

  test.todo(
    'resumes after a process restart from durable provider and settlement evidence (Phase 1-3)',
  );
  test.todo(
    'prevents duplicate provider submission after the provider accepts but the request crashes (Phase 1-3)',
  );
  test.todo(
    'keeps the provider immutable when configuration changes during recovery (Phase 1-3)',
  );
});
