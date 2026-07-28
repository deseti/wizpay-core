import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  mapPayrollFxOperation,
  normalizePayrollFxIntent,
  requireNonNegativeBaseUnits,
  toBoundedDiagnosticJson,
  toPrismaPayrollFxIntent,
  toPrismaPayrollFxStatus,
} from './payroll-fx-operation.mapper';
import {
  PayrollFxOperationIntentConflictError,
  PayrollFxOperationNotFoundError,
  PayrollFxOperationStateConflictError,
  PayrollFxOperationTaskConflictError,
} from './payroll-fx-operation.errors';
import {
  PayrollFxApprovalEvidence,
  PayrollFxFailureEvidence,
  PayrollFxFundingEvidence,
  PayrollFxLeaseFence,
  PayrollFxOperation,
  PayrollFxOperationIntent,
  PayrollFxOperationStatus,
  PayrollFxPayoutEvidence,
  PayrollFxPayoutSubmissionEvidence,
  PayrollFxQuoteEvidence,
  PayrollFxSettlementEvidence,
  PayrollFxSubmissionEvidence,
} from './payroll-fx-operation.types';

@Injectable()
export class PayrollFxOperationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(intent: PayrollFxOperationIntent): Promise<PayrollFxOperation> {
    const record = await this.prisma.payrollFxOperation.create({
      data: toPrismaPayrollFxIntent(randomUUID(), intent),
    });
    return mapPayrollFxOperation(record);
  }

  async createOrGetByIdempotencyKey(
    intent: PayrollFxOperationIntent,
  ): Promise<PayrollFxOperation> {
    const normalizedIntent = normalizePayrollFxIntent(intent);

    try {
      return await this.create(normalizedIntent);
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;

      const existing = await this.findByIdempotencyKey(
        normalizedIntent.idempotencyKey,
      );
      if (!existing) throw error;
      if (!this.hasEquivalentIntent(existing, normalizedIntent)) {
        throw new PayrollFxOperationIntentConflictError(
          normalizedIntent.idempotencyKey,
        );
      }
      return existing;
    }
  }

  async findById(operationId: string): Promise<PayrollFxOperation | null> {
    const record = await this.prisma.payrollFxOperation.findUnique({
      where: { operationId },
    });
    return record ? mapPayrollFxOperation(record) : null;
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<PayrollFxOperation | null> {
    const record = await this.prisma.payrollFxOperation.findUnique({
      where: { idempotencyKey: idempotencyKey.trim() },
    });
    return record ? mapPayrollFxOperation(record) : null;
  }

  async findByTaskId(taskId: string): Promise<PayrollFxOperation | null> {
    const record = await this.prisma.payrollFxOperation.findUnique({
      where: { taskId },
    });
    return record ? mapPayrollFxOperation(record) : null;
  }

  async attachTask(
    operationId: string,
    taskId: string,
  ): Promise<PayrollFxOperation> {
    let attached = false;
    try {
      const result = await this.prisma.payrollFxOperation.updateMany({
        where: { operationId, taskId: null },
        data: { taskId },
      });
      attached = result.count === 1;
    } catch (error) {
      if (!this.isUniqueConstraintError(error)) throw error;
    }

    const operation = await this.findRequired(operationId);
    if (attached || operation.taskId === taskId) return operation;
    throw new PayrollFxOperationTaskConflictError(operationId);
  }

  markQuotePending(
    operationId: string,
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(operationId, 'created', 'quote_pending', {}, fence);
  }

  recordQuote(
    operationId: string,
    expectedStatus: PayrollFxOperationStatus,
    evidence: PayrollFxQuoteEvidence,
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(
      operationId,
      expectedStatus,
      'quote_ready',
      {
        quoteId: evidence.quoteId,
        approvalTargetAddress: evidence.approvalTargetAddress,
        quoteExpiresAt: evidence.quoteExpiresAt,
        expectedOutputBaseUnits:
          evidence.expectedOutputBaseUnits == null
            ? evidence.expectedOutputBaseUnits
            : requireNonNegativeBaseUnits(
                evidence.expectedOutputBaseUnits,
                'expectedOutputBaseUnits',
              ),
        lastProviderStatus: evidence.lastProviderStatus,
        diagnosticSnapshot: toBoundedDiagnosticJson(
          evidence.diagnosticSnapshot,
        ),
      },
      fence,
    );
  }

  markApprovalPending(
    operationId: string,
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(
      operationId,
      'quote_ready',
      'approval_pending',
      {},
      fence,
    );
  }

  recordApproval(
    operationId: string,
    evidence: PayrollFxApprovalEvidence,
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(
      operationId,
      fence ? 'approval_pending' : 'quote_ready',
      'approval_pending',
      {
        approvalTransactionId: evidence.approvalTransactionId,
        approvalTransactionHash: evidence.approvalTransactionHash,
        diagnosticSnapshot: toBoundedDiagnosticJson(
          evidence.diagnosticSnapshot,
        ),
      },
      fence,
    );
  }

  markSubmitted(
    operationId: string,
    expectedStatus: 'quote_ready' | 'approval_pending',
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(operationId, expectedStatus, 'submitted', {}, fence);
  }

  recordSubmission(
    operationId: string,
    expectedStatus: PayrollFxOperationStatus,
    evidence: PayrollFxSubmissionEvidence,
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(
      operationId,
      expectedStatus,
      'submitted',
      {
        providerOperationId: evidence.providerOperationId,
        approvalTransactionId: evidence.approvalTransactionId,
        approvalTransactionHash: evidence.approvalTransactionHash,
        submittedAt: evidence.submittedAt,
        lastProviderStatus: evidence.lastProviderStatus,
        diagnosticSnapshot: toBoundedDiagnosticJson(
          evidence.diagnosticSnapshot,
        ),
      },
      fence,
    );
  }

  markFundingPending(
    operationId: string,
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(
      operationId,
      'submitted',
      'funding_pending',
      {},
      fence,
    );
  }

  recordFunding(
    operationId: string,
    expectedStatus: PayrollFxOperationStatus,
    evidence: PayrollFxFundingEvidence,
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(
      operationId,
      expectedStatus,
      'settlement_pending',
      {
        fundingTransactionId: evidence.fundingTransactionId,
        fundingTransactionHash: evidence.fundingTransactionHash,
        fundingConfirmedAt: evidence.fundingConfirmedAt,
        lastProviderStatus: evidence.lastProviderStatus,
        diagnosticSnapshot: toBoundedDiagnosticJson(
          evidence.diagnosticSnapshot,
        ),
      },
      fence,
    );
  }

  recordSettlement(
    operationId: string,
    expectedStatus: PayrollFxOperationStatus,
    evidence: PayrollFxSettlementEvidence,
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(
      operationId,
      expectedStatus,
      'settled',
      {
        actualOutputBaseUnits: requireNonNegativeBaseUnits(
          evidence.actualOutputBaseUnits,
          'actualOutputBaseUnits',
        ),
        settlementTransactionId: evidence.settlementTransactionId,
        settlementTransactionHash: evidence.settlementTransactionHash,
        settledAt: evidence.settledAt,
        lastProviderStatus: evidence.lastProviderStatus,
        diagnosticSnapshot: toBoundedDiagnosticJson(
          evidence.diagnosticSnapshot,
        ),
      },
      fence,
    );
  }

  recordPayout(
    operationId: string,
    expectedStatus: PayrollFxOperationStatus,
    evidence: PayrollFxPayoutEvidence,
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(
      operationId,
      expectedStatus,
      'completed',
      {
        payoutTransactionId: evidence.payoutTransactionId,
        payoutTransactionHash: evidence.payoutTransactionHash,
        payoutConfirmedAt: evidence.payoutConfirmedAt,
        completedAt: evidence.completedAt,
        diagnosticSnapshot: toBoundedDiagnosticJson(
          evidence.diagnosticSnapshot,
        ),
      },
      fence,
    );
  }

  markPayoutPending(
    operationId: string,
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(operationId, 'settled', 'payout_pending', {}, fence);
  }

  recordPayoutSubmission(
    operationId: string,
    evidence: PayrollFxPayoutSubmissionEvidence,
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(
      operationId,
      'payout_pending',
      'payout_pending',
      {
        payoutTransactionId: evidence.payoutTransactionId,
        payoutTransactionHash: evidence.payoutTransactionHash,
        diagnosticSnapshot: toBoundedDiagnosticJson(
          evidence.diagnosticSnapshot,
        ),
      },
      fence,
    );
  }

  recordFailure(
    operationId: string,
    expectedStatus: PayrollFxOperationStatus,
    evidence: PayrollFxFailureEvidence,
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(
      operationId,
      expectedStatus,
      evidence.status,
      {
        failureCode: evidence.failureCode,
        failureMessage: evidence.failureMessage,
        lastProviderStatus: evidence.lastProviderStatus,
        recoveryFromStatus: toPrismaPayrollFxStatus(expectedStatus),
        diagnosticSnapshot: toBoundedDiagnosticJson(
          evidence.diagnosticSnapshot,
        ),
      },
      fence,
    );
  }

  resumeFromRecovery(
    operationId: string,
    nextStatus: PayrollFxOperationStatus,
    fence: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(
      operationId,
      'recovery_required',
      nextStatus,
      {},
      fence,
    );
  }

  reconcileApprovalToQuoteReady(
    operationId: string,
    expectedStatus: 'approval_pending' | 'recovery_required',
    fence: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(
      operationId,
      expectedStatus,
      'quote_ready',
      {},
      fence,
    );
  }

  retryFailedQuote(
    operationId: string,
    fence: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    return this.transition(operationId, 'failed', 'quote_pending', {}, fence);
  }

  private async transition(
    operationId: string,
    expectedStatus: PayrollFxOperationStatus,
    nextStatus: PayrollFxOperationStatus,
    data: Prisma.PayrollFxOperationUpdateManyMutationInput,
    fence?: PayrollFxLeaseFence,
  ): Promise<PayrollFxOperation> {
    const now = new Date();
    const result = await this.prisma.payrollFxOperation.updateMany({
      where: {
        operationId,
        status: toPrismaPayrollFxStatus(expectedStatus),
        ...(fence
          ? {
              executionLeaseId: fence.leaseId,
              executionLeaseExpiresAt: { gt: now },
            }
          : {}),
      },
      data: {
        ...data,
        status: toPrismaPayrollFxStatus(nextStatus),
      },
    });

    if (result.count !== 1) {
      throw new PayrollFxOperationStateConflictError(
        operationId,
        expectedStatus,
      );
    }
    return this.findRequired(operationId);
  }

  private async findRequired(operationId: string): Promise<PayrollFxOperation> {
    const operation = await this.findById(operationId);
    if (!operation) throw new PayrollFxOperationNotFoundError(operationId);
    return operation;
  }

  private hasEquivalentIntent(
    operation: PayrollFxOperation,
    intent: PayrollFxOperationIntent,
  ): boolean {
    return (
      operation.idempotencyKey === intent.idempotencyKey &&
      operation.walletMode === intent.walletMode &&
      operation.executionProvider === intent.executionProvider &&
      operation.sourceTokenAddress === intent.sourceTokenAddress &&
      operation.destinationTokenAddress === intent.destinationTokenAddress &&
      operation.sourceTokenSymbol === intent.sourceTokenSymbol &&
      operation.destinationTokenSymbol === intent.destinationTokenSymbol &&
      operation.network === intent.network &&
      operation.sourceWalletAddress === intent.sourceWalletAddress &&
      operation.treasuryWalletAddress === intent.treasuryWalletAddress &&
      operation.amountInBaseUnits === intent.amountInBaseUnits &&
      operation.requestedMinimumOutputBaseUnits ===
        (intent.requestedMinimumOutputBaseUnits ?? null)
    );
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'P2002'
    );
  }
}
