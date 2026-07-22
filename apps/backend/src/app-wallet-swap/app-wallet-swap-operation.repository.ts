import { Injectable } from '@nestjs/common';
import { AppWalletSwapOperation, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AppWalletSwapOperationResponse } from './app-wallet-swap.types';

export function toAppWalletSwapNullableJson(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) {
    return Prisma.JsonNull;
  }

  return value as Prisma.InputJsonValue;
}

@Injectable()
export class AppWalletSwapOperationRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperation> {
    return this.prisma.appWalletSwapOperation.create({
      data: this.toCreateInput(operation),
    });
  }

  findById(operationId: string): Promise<AppWalletSwapOperation | null> {
    return this.prisma.appWalletSwapOperation.findUnique({
      where: { operationId },
    });
  }

  update(
    operationId: string,
    data: Prisma.AppWalletSwapOperationUpdateInput,
  ): Promise<AppWalletSwapOperation> {
    return this.prisma.appWalletSwapOperation.update({
      where: { operationId },
      data,
    });
  }

  async claimExecutionLease(
    operationId: string,
    leaseId: string,
    now: Date,
    expiresAt: Date,
  ): Promise<boolean> {
    const result = await this.prisma.appWalletSwapOperation.updateMany({
      where: {
        operationId,
        OR: [
          { executionLeaseId: null },
          { executionLeaseExpiresAt: null },
          { executionLeaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        executionLeaseId: leaseId,
        executionLeaseExpiresAt: expiresAt,
      },
    });

    return result.count === 1;
  }

  async releaseExecutionLease(
    operationId: string,
    leaseId: string,
  ): Promise<void> {
    await this.prisma.appWalletSwapOperation.updateMany({
      where: { operationId, executionLeaseId: leaseId },
      data: { executionLeaseId: null, executionLeaseExpiresAt: null },
    });
  }

  private toCreateInput(
    operation: AppWalletSwapOperationResponse,
  ): Prisma.AppWalletSwapOperationCreateInput {
    return {
      operationId: operation.operationId,
      operationMode: operation.operationMode,
      sourceChain: operation.sourceChain,
      tokenIn: operation.tokenIn,
      tokenOut: operation.tokenOut,
      amountIn: operation.amountIn,
      userWalletAddress: operation.userWalletAddress,
      treasuryDepositAddress: operation.treasuryDepositAddress,
      expectedOutput: toAppWalletSwapNullableJson(operation.expectedOutput),
      minimumOutput: toAppWalletSwapNullableJson(operation.minimumOutput),
      expiresAt: operation.expiresAt,
      status: operation.status,
      quoteId: toAppWalletSwapNullableJson(operation.quoteId),
      rawQuote: toAppWalletSwapNullableJson(operation.rawQuote),
      depositTxHash: operation.depositTxHash,
      circleTransactionId: operation.circleTransactionId,
      circleReferenceId: operation.circleReferenceId,
      circleWalletId: operation.circleWalletId,
      depositSubmittedAt: this.optionalDate(operation.depositSubmittedAt),
      depositConfirmedAt: this.optionalDate(operation.depositConfirmedAt),
      depositConfirmedAmount: operation.depositConfirmedAmount,
      depositConfirmationError: operation.depositConfirmationError,
      executionEnabled: operation.executionEnabled,
      treasurySwapId: operation.treasurySwapId,
      treasurySwapQuoteId: operation.treasurySwapQuoteId,
      treasurySwapTxHash: operation.treasurySwapTxHash,
      treasurySwapSubmittedAt: this.optionalDate(
        operation.treasurySwapSubmittedAt,
      ),
      treasurySwapConfirmedAt: this.optionalDate(
        operation.treasurySwapConfirmedAt,
      ),
      treasurySwapExpectedOutput: toAppWalletSwapNullableJson(
        operation.treasurySwapExpectedOutput,
      ),
      treasurySwapActualOutput: operation.treasurySwapActualOutput,
      rawTreasurySwap: toAppWalletSwapNullableJson(operation.rawTreasurySwap),
      stablefxFundingRequestedAt: this.optionalDate(
        operation.stablefxFundingRequestedAt,
      ),
      stablefxFundedAt: this.optionalDate(operation.stablefxFundedAt),
      payoutTxHash: operation.payoutTxHash,
      payoutAmount: operation.payoutAmount,
      payoutSubmittedAt: this.optionalDate(operation.payoutSubmittedAt),
      payoutConfirmedAt: this.optionalDate(operation.payoutConfirmedAt),
      rawPayout: toAppWalletSwapNullableJson(operation.rawPayout),
      refundTransactionId: operation.refundTransactionId,
      refundTxHash: operation.refundTxHash,
      refundAmount: operation.refundAmount,
      refundSubmittedAt: this.optionalDate(operation.refundSubmittedAt),
      refundConfirmedAt: this.optionalDate(operation.refundConfirmedAt),
      rawRefund: toAppWalletSwapNullableJson(operation.rawRefund),
      completedAt: this.optionalDate(operation.completedAt),
      executionError: operation.executionError,
      createdAt: new Date(operation.createdAt),
      updatedAt: new Date(operation.updatedAt),
    };
  }

  private optionalDate(value: string | undefined): Date | undefined {
    return value ? new Date(value) : undefined;
  }
}
