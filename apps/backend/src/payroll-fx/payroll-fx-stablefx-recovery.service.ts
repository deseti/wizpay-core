import {
  ConflictException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CircleService } from '../adapters/circle.service';
import {
  USER_SWAP_EURC_ADDRESS,
  USER_SWAP_USDC_ADDRESS,
} from '../user-swap/user-swap.service';
import { buildPayrollFxOperationIdempotencyKey } from './payroll-fx-idempotency';
import { PayrollFxExecutionLeaseRepository } from './payroll-fx-execution-lease.repository';
import type { PayrollFxExecutionLease } from './payroll-fx-execution-lease.types';
import { PayrollFxOperationRepository } from './payroll-fx-operation.repository';
import type {
  PayrollFxLeaseFence,
  PayrollFxOperation,
} from './payroll-fx-operation.types';
import { PayrollFxRecoveryPolicy } from './payroll-fx-recovery-policy';
import type { PayrollFxPayoutResult } from './payroll-fx-recovery.types';
import { PayrollFxStablefxLifecycleService } from './payroll-fx-stablefx-lifecycle.service';
import type {
  PayrollFxStablefxLifecycleRequest,
  PayrollFxStablefxLifecycleResult,
} from './payroll-fx-stablefx-lifecycle.types';
import { PayrollFxStablefxOperationService } from './payroll-fx-stablefx-operation.service';
import { PayrollFxStablefxReconciler } from './payroll-fx-stablefx-reconciler';

const TOKEN_ADDRESS: Record<string, string> = {
  USDC: USER_SWAP_USDC_ADDRESS,
  EURC: USER_SWAP_EURC_ADDRESS,
};
const CIRCLE_FAILURE = new Set(['FAILED', 'CANCELLED', 'DENIED']);

@Injectable()
export class PayrollFxStablefxRecoveryService {
  constructor(
    private readonly operations: PayrollFxOperationRepository,
    private readonly operationService: PayrollFxStablefxOperationService,
    private readonly leases: PayrollFxExecutionLeaseRepository,
    private readonly reconciler: PayrollFxStablefxReconciler,
    private readonly lifecycle: PayrollFxStablefxLifecycleService,
    private readonly circle: CircleService,
    private readonly policy: PayrollFxRecoveryPolicy,
  ) {}

  async hasExistingOperation(referenceId: string): Promise<boolean> {
    return Boolean(
      await this.operations.findByIdempotencyKey(
        buildPayrollFxOperationIdempotencyKey(referenceId),
      ),
    );
  }

  async settle(
    request: PayrollFxStablefxLifecycleRequest,
    treasuryAddress: string,
  ): Promise<PayrollFxStablefxLifecycleResult> {
    const operation = await this.loadOrCreate(request, treasuryAddress);
    this.validateStablefxOperation(operation, request, treasuryAddress);
    return this.withLease(operation.operationId, async (current, fence) =>
      this.resumeSettlementState(request, current, fence, treasuryAddress),
    );
  }

  async payout(
    operationId: string,
    input: {
      referenceId: string;
      targetToken: string;
      walletAddress: string;
      payoutAmount: string;
    },
  ): Promise<PayrollFxPayoutResult> {
    return this.withLease(operationId, async (operation, fence) => {
      this.requireStablefx(operation);
      if (operation.status === 'completed') {
        return {
          transactionId: operation.payoutTransactionId,
          transactionHash: operation.payoutTransactionHash,
        };
      }

      let current = operation;
      if (
        current.status === 'recovery_required' &&
        current.recoveryFromStatus === 'payout_pending'
      ) {
        if (!current.payoutTransactionId) this.throwRecoveryRequired(current);
        current = await this.operations.resumeFromRecovery(
          current.operationId,
          'payout_pending',
          fence,
        );
      }

      if (current.status === 'settled') {
        current = await this.operations.markPayoutPending(
          current.operationId,
          fence,
        );
        try {
          const submitted = await this.circle.transfer({
            network: 'ARC-TESTNET',
            token: input.targetToken,
            toAddress: input.walletAddress,
            amount: input.payoutAmount,
            idempotencyKey: `payroll-fx-payout-${input.referenceId}`,
          });
          await this.operations.recordPayoutSubmission(
            current.operationId,
            {
              payoutTransactionId: submitted.txId ?? null,
              payoutTransactionHash: submitted.txHash ?? null,
              diagnosticSnapshot: { stage: 'payout_submitted' },
            },
            fence,
          );
          current = (await this.operations.findById(current.operationId))!;
        } catch (error) {
          await this.markRecovery(
            current,
            fence,
            'PAYROLL_FX_PAYOUT_AMBIGUOUS',
          );
          throw error;
        }
      }

      if (current.status !== 'payout_pending') {
        this.throwRecoveryRequired(current);
      }
      if (current.payoutTransactionHash) {
        await this.operations.recordPayout(
          current.operationId,
          'payout_pending',
          {
            payoutTransactionId: current.payoutTransactionId,
            payoutTransactionHash: current.payoutTransactionHash,
            payoutConfirmedAt: new Date(),
            completedAt: new Date(),
            diagnosticSnapshot: { stage: 'payout_hash_persisted' },
          },
          fence,
        );
        return {
          transactionId: current.payoutTransactionId,
          transactionHash: current.payoutTransactionHash,
        };
      }
      if (!current.payoutTransactionId) {
        await this.markRecovery(current, fence, 'PAYROLL_FX_PAYOUT_ID_MISSING');
        this.throwRecoveryRequired(current);
      }

      const payout = await this.reconciler.readPayout(
        current.payoutTransactionId,
      );
      if (CIRCLE_FAILURE.has(payout.status)) {
        await this.markRecovery(
          current,
          fence,
          'PAYROLL_FX_PAYOUT_TERMINAL_FAILURE',
        );
        this.throwRecoveryRequired(current);
      }
      if (payout.status !== 'COMPLETE') {
        throw this.controlledExit(
          'PAYROLL_FX_PAYOUT_PENDING',
          'The existing Circle payout is still pending.',
        );
      }

      await this.operations.recordPayout(
        current.operationId,
        'payout_pending',
        {
          payoutTransactionId: payout.txId,
          payoutTransactionHash: payout.txHash,
          payoutConfirmedAt: new Date(),
          completedAt: new Date(),
          diagnosticSnapshot: { stage: 'payout_reconciled' },
        },
        fence,
      );
      return {
        transactionId: payout.txId,
        transactionHash: payout.txHash,
      };
    });
  }

  private async resumeSettlementState(
    request: PayrollFxStablefxLifecycleRequest,
    operation: PayrollFxOperation,
    fence: PayrollFxLeaseFence,
    treasuryAddress: string,
  ): Promise<PayrollFxStablefxLifecycleResult> {
    let current = operation;
    if (current.status === 'completed' || current.status === 'settled') {
      return this.toSettlementResult(current);
    }
    if (current.status === 'failed') {
      if (
        current.executionAttemptCount > this.policy.maxPreSideEffectAttempts ||
        !this.policy.isTransientPreSideEffect(current) ||
        !['created', 'quote_pending'].includes(current.recoveryFromStatus ?? '')
      ) {
        this.throwRecoveryRequired(current);
      }
      current = await this.operations.retryFailedQuote(
        current.operationId,
        fence,
      );
    }
    if (current.status === 'recovery_required') {
      current = await this.resumeRecoveryRequired(current, fence);
    }
    if (['created', 'quote_pending', 'quote_ready'].includes(current.status)) {
      return this.lifecycle.settlePersisted(
        request,
        treasuryAddress,
        current,
        fence,
      );
    }
    if (current.status === 'approval_pending') {
      current = await this.reconcileApproval(current, fence);
      return this.lifecycle.settlePersisted(
        request,
        treasuryAddress,
        current,
        fence,
      );
    }
    if (current.status === 'submitted') {
      if (!current.providerOperationId) {
        await this.markRecovery(current, fence, 'PAYROLL_FX_TRADE_ID_MISSING');
        this.throwRecoveryRequired(current);
      }
      const trade = await this.reconciler.readTrade(current);
      return this.lifecycle.resumeSubmitted(request, current, fence, trade);
    }
    if (current.status === 'funding_pending') {
      const trade = await this.reconciler.readTrade(current);
      if (!this.reconciler.fundingIsProven(trade)) {
        await this.markRecovery(current, fence, 'PAYROLL_FX_FUNDING_AMBIGUOUS');
        this.throwRecoveryRequired(current);
      }
      await this.lifecycle.recordReconciledFunding(current, fence, trade);
      current = (await this.operations.findById(current.operationId))!;
    }
    if (current.status === 'settlement_pending') {
      return this.lifecycle.resumeSettlement(request, current, fence);
    }
    this.throwRecoveryRequired(current);
  }

  private async resumeRecoveryRequired(
    operation: PayrollFxOperation,
    fence: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    const from = operation.recoveryFromStatus;
    if (!from) this.throwRecoveryRequired(operation);
    if (['created', 'quote_pending', 'quote_ready'].includes(from)) {
      return this.operations.resumeFromRecovery(
        operation.operationId,
        from,
        fence,
      );
    }
    if (from === 'approval_pending') {
      return this.reconcileApproval(operation, fence);
    }
    if (from === 'submitted' && operation.providerOperationId) {
      return this.operations.resumeFromRecovery(
        operation.operationId,
        'submitted',
        fence,
      );
    }
    if (from === 'funding_pending' && operation.providerOperationId) {
      const trade = await this.reconciler.readTrade(operation);
      if (this.reconciler.fundingIsProven(trade)) {
        return this.operations.resumeFromRecovery(
          operation.operationId,
          'funding_pending',
          fence,
        );
      }
    }
    if (from === 'settlement_pending' && operation.providerOperationId) {
      return this.operations.resumeFromRecovery(
        operation.operationId,
        'settlement_pending',
        fence,
      );
    }
    this.throwRecoveryRequired(operation);
  }

  private async reconcileApproval(
    operation: PayrollFxOperation,
    fence: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    const observed = await this.reconciler.reconcileApproval(operation);
    if (observed.allowanceSufficient) {
      return this.operations.reconcileApprovalToQuoteReady(
        operation.operationId,
        operation.status === 'recovery_required'
          ? 'recovery_required'
          : 'approval_pending',
        fence,
      );
    }
    if (
      observed.transaction &&
      !CIRCLE_FAILURE.has(observed.transaction.status)
    ) {
      throw this.controlledExit(
        'PAYROLL_FX_APPROVAL_PENDING',
        'The existing Circle approval is still pending.',
      );
    }
    await this.markRecovery(operation, fence, 'PAYROLL_FX_APPROVAL_AMBIGUOUS');
    this.throwRecoveryRequired(operation);
  }

  private async loadOrCreate(
    request: PayrollFxStablefxLifecycleRequest,
    treasuryAddress: string,
  ): Promise<PayrollFxOperation> {
    const key = buildPayrollFxOperationIdempotencyKey(request.referenceId);
    const existing = await this.operations.findByIdempotencyKey(key);
    if (existing) return existing;
    const created = await this.operationService.createOrGet(
      request,
      treasuryAddress,
      this.tokenAddress(request.sourceToken),
      this.tokenAddress(request.targetToken),
    );
    if (!created) {
      throw this.controlledExit(
        'PAYROLL_FX_OPERATION_PERSISTENCE_UNAVAILABLE',
        'Payroll FX operation persistence is unavailable.',
      );
    }
    return created;
  }

  private async withLease<T>(
    operationId: string,
    action: (
      operation: PayrollFxOperation,
      fence: PayrollFxLeaseFence,
    ) => Promise<T>,
  ): Promise<T> {
    const lease = await this.leases.acquire(
      operationId,
      this.policy.leaseDurationMs(),
    );
    if (!lease) {
      throw new ConflictException({
        code: 'PAYROLL_FX_OPERATION_BUSY',
        message: 'Payroll FX operation has an active execution lease.',
      });
    }
    try {
      const operation = await this.operations.findById(operationId);
      if (!operation) {
        throw this.controlledExit(
          'PAYROLL_FX_OPERATION_NOT_FOUND',
          'Payroll FX operation was not found after lease acquisition.',
        );
      }
      return await action(operation, { leaseId: lease.leaseId });
    } finally {
      await this.releaseLease(lease);
    }
  }

  private async releaseLease(lease: PayrollFxExecutionLease): Promise<void> {
    await this.leases.release(lease);
  }

  private async markRecovery(
    operation: PayrollFxOperation,
    fence: PayrollFxLeaseFence,
    code: string,
  ): Promise<void> {
    if (operation.status === 'recovery_required') return;
    await this.operations.recordFailure(
      operation.operationId,
      operation.status,
      {
        status: 'recovery_required',
        failureCode: code,
        failureMessage:
          'Recovery evidence is ambiguous; no financial command was repeated.',
        diagnosticSnapshot: { stage: 'reconciliation' },
      },
      fence,
    );
  }

  private validateStablefxOperation(
    operation: PayrollFxOperation,
    request: PayrollFxStablefxLifecycleRequest,
    treasuryAddress: string,
  ): void {
    this.requireStablefx(operation);
    if (
      operation.sourceTokenSymbol !== request.sourceToken.toUpperCase() ||
      operation.destinationTokenSymbol !== request.targetToken.toUpperCase() ||
      operation.amountInBaseUnits !== request.sourceAmount ||
      operation.sourceWalletAddress !== request.walletAddress?.toLowerCase() ||
      operation.treasuryWalletAddress !== treasuryAddress.toLowerCase()
    ) {
      throw new ConflictException({
        code: 'PAYROLL_FX_OPERATION_INTENT_CONFLICT',
        message: 'Payroll FX recovery request conflicts with immutable intent.',
      });
    }
  }

  private requireStablefx(operation: PayrollFxOperation): void {
    if (operation.executionProvider !== 'stablefx') {
      throw this.controlledExit(
        'PAYROLL_FX_RECOVERY_PROVIDER_UNSUPPORTED',
        'Only persisted StableFX Payroll operations can use this recovery path.',
      );
    }
  }

  private toSettlementResult(
    operation: PayrollFxOperation,
  ): PayrollFxStablefxLifecycleResult {
    return {
      sourceToken: operation.sourceTokenSymbol,
      targetToken: operation.destinationTokenSymbol,
      sourceAmount: operation.amountInBaseUnits,
      targetAmount:
        operation.actualOutputBaseUnits ??
        operation.expectedOutputBaseUnits ??
        operation.amountInBaseUnits,
      txHash: operation.settlementTransactionHash,
      status: 'settled',
      operationId: operation.operationId,
    };
  }

  private tokenAddress(token: string): string {
    const address = TOKEN_ADDRESS[token.toUpperCase()];
    if (!address) {
      throw this.controlledExit(
        'PAYROLL_FX_SETTLEMENT_EXECUTION_FAILED',
        `Unsupported token "${token}" for Payroll FX settlement.`,
      );
    }
    return address;
  }

  private throwRecoveryRequired(operation: PayrollFxOperation): never {
    throw this.controlledExit(
      'PAYROLL_FX_RECOVERY_REQUIRED',
      `Payroll FX operation ${operation.operationId} requires manual recovery review.`,
    );
  }

  private controlledExit(
    code: string,
    message: string,
  ): ServiceUnavailableException {
    return new ServiceUnavailableException({ code, message });
  }
}
