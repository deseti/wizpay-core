import { AppWalletSwapOperation } from '@prisma/client';
import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import {
  USER_SWAP_EURC_ADDRESS,
  USER_SWAP_USDC_ADDRESS,
} from '../user-swap/user-swap.service';
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import {
  equalsIgnoreCase,
  isFailedCircleTransactionStatus,
  normalizeTokenAmountToBaseUnits,
} from './app-wallet-swap-circle-transaction-matcher';
import { mapAppWalletSwapOperationRecord } from './app-wallet-swap-operation.mapper';
import {
  AppWalletSwapOperationRepository,
  toAppWalletSwapNullableJson,
} from './app-wallet-swap-operation.repository';
import { sanitizeAppWalletSwapPayload } from './app-wallet-swap-payload-sanitizer';
import { toPublicAppWalletSwapOperation } from './app-wallet-swap-public.mapper';
import {
  getNestedString,
  validTransactionHashOrNull,
} from './app-wallet-swap-provider-reference';
import {
  AppWalletSwapStablefxExecutorService,
  AppWalletSwapStablefxResponseError,
} from './app-wallet-swap-stablefx-executor.service';
import { AppWalletSwapTreasuryVerifierService } from './app-wallet-swap-treasury-verifier.service';
import {
  APP_WALLET_SWAP_CHAIN,
  APP_WALLET_SWAP_ERROR_CODES,
  AppWalletSwapOperationResponse,
  AppWalletSwapToken,
} from './app-wallet-swap.types';

const TOKEN_ADDRESS_BY_SYMBOL: Record<AppWalletSwapToken, string> = {
  USDC: USER_SWAP_USDC_ADDRESS,
  EURC: USER_SWAP_EURC_ADDRESS,
};
const TOKEN_DECIMALS_BY_SYMBOL: Record<AppWalletSwapToken, number> = {
  USDC: 6,
  EURC: 6,
};
const DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS = 20 * 1000;
const EXECUTION_LEASE_MS = 15 * 60 * 1000;

class TerminalExecutionError extends Error {}

@Injectable()
export class AppWalletSwapRefundService {
  constructor(
    private readonly treasuryVerifier: AppWalletSwapTreasuryVerifierService,
    private readonly circleExecutor: AppWalletSwapCircleExecutorService,
    private readonly stablefxExecutor: AppWalletSwapStablefxExecutorService,
    private readonly operationRepository: AppWalletSwapOperationRepository,
  ) {}

  async recover(operationId: string): Promise<AppWalletSwapOperationResponse> {
    const leaseId = randomUUID();
    if (!(await this.claimExecution(operationId, leaseId))) {
      return this.getPublicOperation(operationId);
    }

    try {
      let operation = await this.getOperation(operationId);
      operation = await this.submitRefundIfSafe(operation);
      return this.toPublicOperation(
        await this.confirmRefundIfPossible(operation),
      );
    } catch (error) {
      return this.toPublicOperation(
        await this.markExecutionError(operationId, error),
      );
    } finally {
      await this.releaseExecution(operationId, leaseId);
    }
  }

  private async claimExecution(
    operationId: string,
    leaseId: string,
  ): Promise<boolean> {
    const now = new Date();

    return this.operationRepository.claimExecutionLease(
      operationId,
      leaseId,
      now,
      new Date(now.getTime() + EXECUTION_LEASE_MS),
    );
  }

  private async releaseExecution(
    operationId: string,
    leaseId: string,
  ): Promise<void> {
    await this.operationRepository.releaseExecutionLease(operationId, leaseId);
  }

  private async submitRefundIfSafe(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (operation.refundSubmittedAt || operation.refundTransactionId) {
      return operation;
    }

    const refundAmount = operation.depositConfirmedAmount;
    if (
      !refundAmount ||
      operation.treasurySwapConfirmedAt ||
      operation.payoutSubmittedAt
    ) {
      throw new TerminalExecutionError(
        'Refund is not safe because the verified deposit amount is unavailable or settlement/payout has already advanced.',
      );
    }

    const fundingWasAttempted =
      operation.provider === 'stablefx' &&
      (Boolean(operation.stablefxFundingRequestedAt) ||
        Boolean(operation.stablefxFundedAt) ||
        this.containsObjectKey(operation.rawTreasurySwap, 'fund'));
    if (fundingWasAttempted) {
      if (!operation.treasurySwapId) {
        throw new TerminalExecutionError(
          'Refund is blocked because StableFX funding was submitted without a recoverable trade identifier.',
        );
      }
      const trade = await this.pollStablefxTrade(operation.treasurySwapId);
      if (!trade.isFailure) {
        throw new TerminalExecutionError(
          'Refund is blocked while the funded StableFX trade is not in a terminal failure/refund state.',
        );
      }
    }

    const balances = await this.withProviderTimeout(
      this.circleExecutor.getWalletBalance(
        this.getArcTreasuryWalletId(),
        TOKEN_ADDRESS_BY_SYMBOL[operation.tokenIn],
      ),
      'Treasury balance verification timed out.',
    );
    const matchingBalance = balances.find((balance) =>
      equalsIgnoreCase(
        balance.tokenAddress,
        TOKEN_ADDRESS_BY_SYMBOL[operation.tokenIn],
      ),
    );
    const available = matchingBalance
      ? normalizeTokenAmountToBaseUnits(
          matchingBalance.amount,
          TOKEN_DECIMALS_BY_SYMBOL[operation.tokenIn],
        )
      : null;

    if (available === null || available < BigInt(refundAmount)) {
      throw new TerminalExecutionError(
        `Refund is blocked because the treasury does not hold the verified ${operation.tokenIn} deposit amount.`,
      );
    }

    operation = this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        status: 'refund_pending',
        refundAmount,
        executionError: null,
        updatedAt: new Date(),
      }),
    );
    const transfer = await this.circleExecutor.submitTransfer({
      walletId: this.getArcTreasuryWalletId(),
      network: APP_WALLET_SWAP_CHAIN,
      token: operation.tokenIn,
      toAddress: operation.userWalletAddress,
      amount: this.circleExecutor.formatBaseUnits(refundAmount, 6),
      idempotencyKey: this.deriveIdempotencyKey(
        operation.operationId,
        'deposit-refund',
      ),
    });

    return this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        status: 'refund_submitted',
        refundTransactionId: transfer.txId,
        refundTxHash: validTransactionHashOrNull(transfer.txHash),
        refundSubmittedAt: new Date(),
        rawRefund: toAppWalletSwapNullableJson({
          provider: 'circle',
          transactionId: transfer.txId,
          txHash: validTransactionHashOrNull(transfer.txHash),
          providerStatus: transfer.status,
          transfer: this.sanitizeForPersistence(transfer),
          observedAt: new Date().toISOString(),
        }),
        executionError: null,
        updatedAt: new Date(),
      }),
    );
  }

  private async confirmRefundIfPossible(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (operation.status === 'refunded') return operation;
    if (!operation.refundSubmittedAt || !operation.refundAmount)
      return operation;

    const refundAmount = operation.refundAmount;
    let txHash = operation.refundTxHash;
    if (!txHash && operation.refundTransactionId) {
      const status = await this.withProviderTimeout(
        this.circleExecutor.getTransactionStatus(operation.refundTransactionId),
        'Refund transaction polling timed out.',
      );
      if (isFailedCircleTransactionStatus(status.status)) {
        throw new TerminalExecutionError(
          `Refund Circle transaction failed with status ${status.status}${status.errorReason ? `: ${status.errorReason}` : ''}`,
        );
      }
      txHash = validTransactionHashOrNull(status.txHash) ?? undefined;
      operation = this.mapOperationRecord(
        await this.operationRepository.update(operation.operationId, {
          ...(txHash ? { refundTxHash: txHash } : {}),
          rawRefund: toAppWalletSwapNullableJson({
            provider: 'circle',
            transactionId: operation.refundTransactionId,
            txHash: txHash ?? null,
            providerStatus: status.status,
            status: this.sanitizeForPersistence(status),
            observedAt: new Date().toISOString(),
          }),
          updatedAt: new Date(),
        }),
      );
    }

    if (!txHash) return operation;
    const verification = await this.withProviderTimeout(
      this.treasuryVerifier.verifyPayout({
        tokenOut: operation.tokenIn,
        txHash,
        treasuryAddress: operation.treasuryDepositAddress,
        userWalletAddress: operation.userWalletAddress,
        payoutAmount: refundAmount,
      }),
      'Refund on-chain confirmation timed out.',
    );
    if (!verification.confirmed) return operation;

    const confirmedAt = new Date();
    return this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        status: 'refunded',
        refundTxHash: txHash,
        refundConfirmedAt: confirmedAt,
        executionError: null,
        updatedAt: confirmedAt,
      }),
    );
  }

  private async getOperation(
    operationId: string,
  ): Promise<AppWalletSwapOperationResponse> {
    const operation = await this.operationRepository.findById(operationId);

    if (!operation) {
      throw new NotFoundException({
        code: APP_WALLET_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'App Wallet swap operation was not found.',
      });
    }

    return this.mapOperationRecord(operation);
  }

  private async getPublicOperation(
    operationId: string,
  ): Promise<AppWalletSwapOperationResponse> {
    return this.toPublicOperation(await this.getOperation(operationId));
  }

  private async markExecutionError(
    operationId: string,
    error: unknown,
  ): Promise<AppWalletSwapOperationResponse> {
    const operation = await this.getOperation(operationId);
    const terminal =
      error instanceof TerminalExecutionError ||
      error instanceof BadGatewayException ||
      error instanceof AppWalletSwapStablefxResponseError ||
      (error instanceof BadRequestException &&
        Boolean(operation.treasurySwapId));
    return this.mapOperationRecord(
      await this.operationRepository.update(operationId, {
        ...(terminal
          ? {
              status: operation.depositConfirmedAt
                ? 'execution_recovery_required'
                : 'execution_failed',
            }
          : {}),
        executionError: this.getPublicErrorMessage(error),
        updatedAt: new Date(),
      }),
    );
  }

  private mapOperationRecord(
    record: AppWalletSwapOperation,
  ): AppWalletSwapOperationResponse {
    return mapAppWalletSwapOperationRecord(record);
  }

  private toPublicOperation(
    operation: AppWalletSwapOperationResponse,
  ): AppWalletSwapOperationResponse {
    return toPublicAppWalletSwapOperation(operation);
  }

  private sanitizeForPersistence(value: unknown): unknown {
    return sanitizeAppWalletSwapPayload(value);
  }

  private deriveIdempotencyKey(operationId: string, purpose: string): string {
    const hex = createHash('sha256')
      .update(`${operationId}:${purpose}`)
      .digest('hex');
    const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);

    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `4${hex.slice(13, 16)}`,
      `${variant}${hex.slice(17, 20)}`,
      hex.slice(20, 32),
    ].join('-');
  }

  private async pollStablefxTrade(tradeId: string) {
    return this.withProviderTimeout(
      this.stablefxExecutor.getTradeState(tradeId),
      'StableFX trade polling timed out.',
    );
  }

  private containsObjectKey(value: unknown, targetKey: string): boolean {
    if (Array.isArray(value)) {
      return value.some((item) => this.containsObjectKey(item, targetKey));
    }
    if (!this.isRecord(value)) return false;
    if (Object.prototype.hasOwnProperty.call(value, targetKey)) return true;
    return Object.values(value).some((item) =>
      this.containsObjectKey(item, targetKey),
    );
  }

  private async withProviderTimeout<T>(
    promise: Promise<T>,
    message: string,
  ): Promise<T> {
    const configured = Number(process.env.APP_WALLET_PROVIDER_TIMEOUT_MS);
    const timeoutMs =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timer = setTimeout(
            () => reject(new TerminalExecutionError(message)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private getArcTreasuryWalletId(): string {
    const walletId = process.env.CIRCLE_WALLET_ID_ARC?.trim();

    if (!walletId) {
      throw new ServiceUnavailableException({
        code: APP_WALLET_SWAP_ERROR_CODES.TREASURY_NOT_CONFIGURED,
        message:
          'Arc treasury wallet id is not configured for App Wallet swap.',
      });
    }

    return walletId;
  }

  private getPublicErrorMessage(error: unknown): string {
    if (error instanceof BadRequestException) {
      const response = error.getResponse();
      if (typeof response === 'string' && response.trim()) return response;
      if (this.isRecord(response)) {
        const message = response.message;
        if (typeof message === 'string' && message.trim()) return message;
        if (this.isRecord(message)) {
          const nestedMessage = getNestedString(message, ['message']);
          if (nestedMessage) return nestedMessage;
        }
      }
      return 'App Wallet swap execution request is invalid.';
    }

    if (error instanceof ServiceUnavailableException) {
      return 'App Wallet swap execution is not available.';
    }

    if (error instanceof Error && error.message) {
      return error.message;
    }

    return 'App Wallet swap execution failed.';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
