import { AppWalletSwapOperation } from '@prisma/client';
import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  USER_SWAP_EURC_ADDRESS,
  USER_SWAP_USDC_ADDRESS,
} from '../user-swap/user-swap.service';
import { mapAppWalletSwapOperationRecord } from './app-wallet-swap-operation.mapper';
import {
  AppWalletSwapOperationRepository,
  toAppWalletSwapNullableJson,
} from './app-wallet-swap-operation.repository';
import { AppWalletSwapPayoutExecutorService } from './app-wallet-swap-payout-executor.service';
import { AppWalletSwapTreasuryVerifierService } from './app-wallet-swap-treasury-verifier.service';
import {
  APP_WALLET_SWAP_CHAIN,
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

export class AppWalletSwapPayoutTerminalError extends Error {}

@Injectable()
export class AppWalletSwapPayoutService {
  constructor(
    private readonly payoutExecutor: AppWalletSwapPayoutExecutorService,
    private readonly treasuryVerifier: AppWalletSwapTreasuryVerifierService,
    private readonly operationRepository: AppWalletSwapOperationRepository,
  ) {}

  async progress(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (!operation.treasurySwapConfirmedAt) {
      return operation;
    }

    const submitted = await this.submitPayoutIfNeeded(operation);
    return this.confirmPayoutIfPossible(submitted);
  }

  private async submitPayoutIfNeeded(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (operation.payoutSubmittedAt || operation.payoutTxHash) {
      return operation;
    }

    if (!operation.treasurySwapActualOutput) {
      return operation;
    }

    const pendingOperation = this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        status: 'payout_pending',
        executionError: null,
        updatedAt: new Date(),
      }),
    );
    const payoutAmount = pendingOperation.treasurySwapActualOutput;

    if (!payoutAmount) {
      return pendingOperation;
    }

    const payout = await this.payoutExecutor.submitPayout({
      walletId: process.env.CIRCLE_WALLET_ID_ARC?.trim(),
      network: APP_WALLET_SWAP_CHAIN,
      token: pendingOperation.tokenOut,
      recipientAddress: pendingOperation.userWalletAddress,
      payoutAmount,
      tokenDecimals: TOKEN_DECIMALS_BY_SYMBOL[pendingOperation.tokenOut],
      idempotencyKey: this.deriveIdempotencyKey(
        pendingOperation.operationId,
        'payout',
      ),
    });

    return this.mapOperationRecord(
      await this.operationRepository.update(pendingOperation.operationId, {
        status: 'payout_submitted',
        payoutAmount,
        payoutTxHash: payout.txHash,
        payoutSubmittedAt: new Date(),
        rawPayout: toAppWalletSwapNullableJson(payout.snapshot),
        executionError: null,
        updatedAt: new Date(),
      }),
    );
  }

  private async confirmPayoutIfPossible(
    operation: AppWalletSwapOperationResponse,
  ): Promise<AppWalletSwapOperationResponse> {
    if (operation.status === 'completed') {
      return operation;
    }

    if (!operation.payoutSubmittedAt || !operation.payoutAmount) {
      return operation;
    }

    const payoutAmount = operation.payoutAmount;
    const storedReferences = this.payoutExecutor.getStoredPayoutReferences(
      operation.rawPayout,
    );
    let txHash = operation.payoutTxHash ?? storedReferences.txHash ?? undefined;

    if (operation.rawPayout && !txHash) {
      const payoutTransactionId = storedReferences.transactionId;

      if (payoutTransactionId) {
        const payoutStatus = await this.payoutExecutor
          .getPayoutStatus(payoutTransactionId)
          .catch(() => null);

        if (payoutStatus) {
          if (payoutStatus.failed) {
            throw new AppWalletSwapPayoutTerminalError(
              `Payout Circle transaction failed with status ${payoutStatus.providerStatus}${payoutStatus.errorReason ? `: ${payoutStatus.errorReason}` : ''}`,
            );
          }

          txHash = payoutStatus.txHash ?? undefined;

          operation = this.mapOperationRecord(
            await this.operationRepository.update(operation.operationId, {
              ...(txHash ? { payoutTxHash: txHash } : {}),
              rawPayout: toAppWalletSwapNullableJson(payoutStatus.snapshot),
              updatedAt: new Date(),
            }),
          );
        }
      }
    }

    if (!txHash) {
      const resolved = await this.resolvePayoutTxHashFromCircleList(operation);

      if (resolved) {
        txHash = resolved.txHash;
        operation = resolved.operation;
      }
    }

    if (!txHash) {
      return operation;
    }

    const verification = await this.withProviderTimeout(
      this.treasuryVerifier.verifyPayout({
        tokenOut: operation.tokenOut,
        txHash,
        treasuryAddress: operation.treasuryDepositAddress,
        userWalletAddress: operation.userWalletAddress,
        payoutAmount,
      }),
      'Payout on-chain confirmation timed out.',
    );

    if (!verification.confirmed) {
      return operation;
    }

    return this.finalizePayout(operation, txHash);
  }

  private async finalizePayout(
    operation: AppWalletSwapOperationResponse,
    txHash: string,
  ): Promise<AppWalletSwapOperationResponse> {
    const payoutConfirmedAt = new Date();
    const completedAt = new Date();

    return this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        status: 'completed',
        payoutTxHash: txHash,
        payoutConfirmedAt,
        completedAt,
        executionError: null,
        updatedAt: completedAt,
      }),
    );
  }

  private async resolvePayoutTxHashFromCircleList(
    operation: AppWalletSwapOperationResponse,
  ): Promise<{
    operation: AppWalletSwapOperationResponse;
    txHash: string;
  } | null> {
    const treasuryWalletId = process.env.CIRCLE_WALLET_ID_ARC?.trim();

    if (!treasuryWalletId) {
      return null;
    }

    const recovered = await this.payoutExecutor
      .recoverPayoutReference({
        treasuryWalletId,
        tokenAddresses: TOKEN_ADDRESS_BY_SYMBOL,
        payout: {
          tokenOut: operation.tokenOut,
          payoutAmount: operation.payoutAmount!,
          treasuryDepositAddress: operation.treasuryDepositAddress,
          userWalletAddress: operation.userWalletAddress,
          payoutSubmittedAt: operation.payoutSubmittedAt!,
        },
        existingTransactionId: this.payoutExecutor.getStoredPayoutReferences(
          operation.rawPayout,
        ).transactionId,
      })
      .catch(() => null);

    if (!recovered) {
      return null;
    }

    const updatedOperation = this.mapOperationRecord(
      await this.operationRepository.update(operation.operationId, {
        payoutTxHash: recovered.txHash,
        rawPayout: toAppWalletSwapNullableJson(recovered.snapshot),
        updatedAt: new Date(),
      }),
    );

    return { operation: updatedOperation, txHash: recovered.txHash! };
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
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private mapOperationRecord(
    record: AppWalletSwapOperation,
  ): AppWalletSwapOperationResponse {
    return mapAppWalletSwapOperationRecord(record);
  }
}
