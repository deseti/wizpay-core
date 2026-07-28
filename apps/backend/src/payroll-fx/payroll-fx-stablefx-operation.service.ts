import {
  ConflictException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { USER_SWAP_ALLOWED_CHAIN } from '../user-swap/user-swap.types';
import { buildPayrollFxSafeFailure } from './payroll-fx-diagnostics';
import { buildPayrollFxOperationIdempotencyKey } from './payroll-fx-idempotency';
import { PayrollFxOperationStateConflictError } from './payroll-fx-operation.errors';
import { PayrollFxOperationRepository } from './payroll-fx-operation.repository';
import type {
  PayrollFxApprovalEvidence,
  PayrollFxFundingEvidence,
  PayrollFxLeaseFence,
  PayrollFxOperation,
  PayrollFxQuoteEvidence,
  PayrollFxSettlementEvidence,
  PayrollFxSubmissionEvidence,
} from './payroll-fx-operation.types';
import type {
  PayrollFxStablefxLifecycleRequest,
  PayrollFxStablefxPayoutCompletion,
  PayrollFxStablefxPayoutSubmission,
} from './payroll-fx-stablefx-lifecycle.types';

@Injectable()
export class PayrollFxStablefxOperationService {
  private readonly logger = new Logger(PayrollFxStablefxOperationService.name);

  constructor(
    @Optional()
    private readonly repository?: PayrollFxOperationRepository,
  ) {}

  async createOrGet(
    request: PayrollFxStablefxLifecycleRequest,
    treasuryAddress: string,
    sourceTokenAddress: string,
    destinationTokenAddress: string,
  ): Promise<PayrollFxOperation | null> {
    if (!this.repository) return null;
    const sourceWalletAddress = request.walletAddress?.trim().toLowerCase();
    if (
      !sourceWalletAddress ||
      !/^0x[a-fA-F0-9]{40}$/.test(sourceWalletAddress)
    ) {
      throw new ServiceUnavailableException({
        code: 'PAYROLL_FX_OPERATION_CONTEXT_MISSING',
        message:
          'StableFX Payroll lifecycle persistence requires the App Wallet address.',
      });
    }

    return this.repository.createOrGetByIdempotencyKey({
      idempotencyKey: buildPayrollFxOperationIdempotencyKey(
        request.referenceId,
      ),
      walletMode: 'app',
      executionProvider: 'stablefx',
      sourceTokenAddress,
      destinationTokenAddress,
      sourceTokenSymbol: request.sourceToken,
      destinationTokenSymbol: request.targetToken,
      network: USER_SWAP_ALLOWED_CHAIN,
      sourceWalletAddress,
      treasuryWalletAddress: treasuryAddress,
      amountInBaseUnits: request.sourceAmount,
      requestedMinimumOutputBaseUnits: null,
    });
  }

  async begin(
    request: PayrollFxStablefxLifecycleRequest,
    treasuryAddress: string,
    sourceTokenAddress: string,
    destinationTokenAddress: string,
  ): Promise<PayrollFxOperation | null> {
    const operation = await this.createOrGet(
      request,
      treasuryAddress,
      sourceTokenAddress,
      destinationTokenAddress,
    );
    if (!operation) return null;
    if (operation.status !== 'created') {
      throw this.alreadyStarted(operation.operationId, operation.status);
    }

    try {
      return await this.repository!.markQuotePending(operation.operationId);
    } catch (error) {
      if (error instanceof PayrollFxOperationStateConflictError) {
        throw this.alreadyStarted(operation.operationId, 'non-created');
      }
      throw error;
    }
  }

  async recordQuote(
    operationId: string,
    evidence: PayrollFxQuoteEvidence,
    expectedStatus: 'quote_pending' | 'quote_ready' = 'quote_pending',
    fence?: PayrollFxLeaseFence,
  ): Promise<void> {
    if (fence) {
      await this.repository?.recordQuote(
        operationId,
        expectedStatus,
        evidence,
        fence,
      );
    } else {
      await this.repository?.recordQuote(operationId, expectedStatus, evidence);
    }
  }

  async markQuotePending(
    operationId: string,
    fence?: PayrollFxLeaseFence,
  ): Promise<void> {
    await this.repository?.markQuotePending(operationId, fence);
  }

  async markApprovalPending(
    operationId: string,
    fence?: PayrollFxLeaseFence,
  ): Promise<void> {
    await this.repository?.markApprovalPending(operationId, fence);
  }

  async recordApproval(
    operationId: string,
    evidence: PayrollFxApprovalEvidence,
    fence?: PayrollFxLeaseFence,
  ): Promise<void> {
    if (fence) {
      await this.repository?.recordApproval(operationId, evidence, fence);
    } else {
      await this.repository?.recordApproval(operationId, evidence);
    }
  }

  async markSubmitted(
    operationId: string,
    expectedStatus: 'quote_ready' | 'approval_pending',
    fence?: PayrollFxLeaseFence,
  ): Promise<void> {
    await this.repository?.markSubmitted(operationId, expectedStatus, fence);
  }

  async recordSubmission(
    operationId: string,
    expectedStatus: 'quote_ready' | 'approval_pending' | 'submitted',
    evidence: PayrollFxSubmissionEvidence,
    fence?: PayrollFxLeaseFence,
  ): Promise<void> {
    if (fence) {
      await this.repository?.recordSubmission(
        operationId,
        expectedStatus,
        evidence,
        fence,
      );
    } else {
      await this.repository?.recordSubmission(
        operationId,
        expectedStatus,
        evidence,
      );
    }
  }

  async markFundingPending(
    operationId: string,
    fence?: PayrollFxLeaseFence,
  ): Promise<void> {
    await this.repository?.markFundingPending(operationId, fence);
  }

  async recordFunding(
    operationId: string,
    evidence: PayrollFxFundingEvidence,
    expectedStatus: 'submitted' | 'funding_pending' = 'submitted',
    fence?: PayrollFxLeaseFence,
  ): Promise<void> {
    if (fence) {
      await this.repository?.recordFunding(
        operationId,
        expectedStatus,
        evidence,
        fence,
      );
    } else {
      await this.repository?.recordFunding(
        operationId,
        expectedStatus,
        evidence,
      );
    }
  }

  async recordSettlement(
    operationId: string,
    evidence: PayrollFxSettlementEvidence,
    fence?: PayrollFxLeaseFence,
  ): Promise<void> {
    if (fence) {
      await this.repository?.recordSettlement(
        operationId,
        'settlement_pending',
        evidence,
        fence,
      );
    } else {
      await this.repository?.recordSettlement(
        operationId,
        'settlement_pending',
        evidence,
      );
    }
  }

  async recordPayoutSubmission(
    operationId: string,
    evidence: PayrollFxStablefxPayoutSubmission,
    fence?: PayrollFxLeaseFence,
  ): Promise<void> {
    const payoutEvidence = {
      payoutTransactionId: evidence.transactionId,
      payoutTransactionHash: evidence.transactionHash,
      diagnosticSnapshot: { stage: 'payout_submitted' },
    };
    if (fence) {
      await this.repository?.recordPayoutSubmission(
        operationId,
        payoutEvidence,
        fence,
      );
    } else {
      await this.repository?.recordPayoutSubmission(
        operationId,
        payoutEvidence,
      );
    }
  }

  async recordPayoutCompletion(
    operationId: string,
    evidence: PayrollFxStablefxPayoutCompletion,
    fence?: PayrollFxLeaseFence,
  ): Promise<void> {
    const payoutEvidence = {
      payoutTransactionId: evidence.transactionId,
      payoutTransactionHash: evidence.transactionHash,
      payoutConfirmedAt: evidence.confirmedAt,
      completedAt: evidence.confirmedAt,
      diagnosticSnapshot: { stage: 'payout_confirmed' },
    };
    if (fence) {
      await this.repository?.recordPayout(
        operationId,
        'payout_pending',
        payoutEvidence,
        fence,
      );
    } else {
      await this.repository?.recordPayout(
        operationId,
        'payout_pending',
        payoutEvidence,
      );
    }
  }

  async recordFailureSafely(
    operationId: string,
    error: unknown,
    stage: string,
    externalSideEffectPossible: boolean,
    fence?: PayrollFxLeaseFence,
  ): Promise<void> {
    if (!this.repository) return;
    try {
      const current = await this.repository.findById(operationId);
      if (
        !current ||
        ['completed', 'failed', 'recovery_required'].includes(current.status)
      ) {
        return;
      }
      const safeFailure = buildPayrollFxSafeFailure(error, stage);
      const evidence = {
        status: externalSideEffectPossible
          ? ('recovery_required' as const)
          : ('failed' as const),
        ...safeFailure,
      };
      if (fence) {
        await this.repository.recordFailure(
          operationId,
          current.status,
          evidence,
          fence,
        );
      } else {
        await this.repository.recordFailure(
          operationId,
          current.status,
          evidence,
        );
      }
    } catch (persistenceError) {
      this.logger.error(
        `Payroll FX failure persistence failed operationId=${operationId} ` +
          `stage=${stage} errorType=${
            persistenceError instanceof Error
              ? persistenceError.constructor.name
              : typeof persistenceError
          }`,
      );
    }
  }

  private alreadyStarted(
    operationId: string,
    status: string,
  ): ConflictException {
    return new ConflictException({
      code: 'PAYROLL_FX_OPERATION_ALREADY_STARTED',
      message:
        `Payroll FX operation ${operationId} is already in state ${status}; ` +
        'automatic retry or resume is not available.',
    });
  }
}
