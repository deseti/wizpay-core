import { Injectable } from '@nestjs/common';
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import {
  findMatchingCirclePayoutTransaction,
  isFailedCircleTransactionStatus,
  type AppWalletSwapTokenAddresses,
} from './app-wallet-swap-circle-transaction-matcher';
import { sanitizeAppWalletSwapPayload } from './app-wallet-swap-payload-sanitizer';
import {
  extractCircleTransactionHash,
  extractCircleTransactionId,
  getNestedString,
  getPayoutTransactionHash,
  getPayoutTransactionId,
  validTransactionHashOrNull,
} from './app-wallet-swap-provider-reference';
import type { AppWalletSwapToken } from './app-wallet-swap.types';

export interface AppWalletSwapPayoutSubmissionInput {
  readonly walletId?: string;
  readonly network: string;
  readonly token: AppWalletSwapToken;
  readonly recipientAddress: string;
  readonly payoutAmount: string;
  readonly tokenDecimals: number;
  readonly idempotencyKey: string;
}

export interface AppWalletSwapPayoutMatchInput {
  readonly tokenOut: AppWalletSwapToken;
  readonly payoutAmount: string;
  readonly treasuryDepositAddress: string;
  readonly userWalletAddress: string;
  readonly payoutSubmittedAt: string;
}

export interface AppWalletSwapPayoutRecoveryInput {
  readonly treasuryWalletId: string;
  readonly tokenAddresses: AppWalletSwapTokenAddresses;
  readonly payout: AppWalletSwapPayoutMatchInput;
  readonly existingTransactionId?: string | null;
}

export interface AppWalletSwapPayoutProviderResult {
  readonly transactionId: string | null;
  readonly txHash: string | null;
  readonly providerStatus: string;
  readonly snapshot: Record<string, unknown>;
}

export interface AppWalletSwapPayoutStatusResult extends AppWalletSwapPayoutProviderResult {
  readonly failed: boolean;
  readonly errorReason: string | null;
}

@Injectable()
export class AppWalletSwapPayoutExecutorService {
  constructor(
    private readonly circleExecutor: AppWalletSwapCircleExecutorService,
  ) {}

  getStoredPayoutReferences(rawPayout: unknown): {
    readonly transactionId: string | null;
    readonly txHash: string | null;
  } {
    return {
      transactionId: getPayoutTransactionId(rawPayout),
      txHash: getPayoutTransactionHash(rawPayout),
    };
  }

  async submitPayout(
    input: AppWalletSwapPayoutSubmissionInput,
  ): Promise<AppWalletSwapPayoutProviderResult> {
    const transfer = await this.circleExecutor.submitTransfer({
      walletId: input.walletId,
      network: input.network,
      token: input.token,
      toAddress: input.recipientAddress,
      amount: this.circleExecutor.formatBaseUnits(
        input.payoutAmount,
        input.tokenDecimals,
      ),
      idempotencyKey: input.idempotencyKey,
    });
    const txHash = validTransactionHashOrNull(transfer.txHash);

    return {
      transactionId: transfer.txId,
      txHash,
      providerStatus: transfer.status,
      snapshot: {
        provider: 'circle',
        transactionId: transfer.txId,
        txHash,
        providerStatus: transfer.status,
        transfer: sanitizeAppWalletSwapPayload(transfer),
        observedAt: new Date().toISOString(),
      },
    };
  }

  async getPayoutStatus(
    transactionId: string,
  ): Promise<AppWalletSwapPayoutStatusResult> {
    const status =
      await this.circleExecutor.getTransactionStatus(transactionId);
    const txHash = validTransactionHashOrNull(status.txHash);

    return {
      transactionId,
      txHash,
      providerStatus: status.status,
      failed: isFailedCircleTransactionStatus(status.status),
      errorReason: status.errorReason,
      snapshot: {
        provider: 'circle',
        transactionId,
        txHash,
        providerStatus: status.status,
        status: sanitizeAppWalletSwapPayload(status),
        observedAt: new Date().toISOString(),
      },
    };
  }

  async recoverPayoutReference(
    input: AppWalletSwapPayoutRecoveryInput,
  ): Promise<AppWalletSwapPayoutProviderResult | null> {
    const response = await this.circleExecutor.listW3sTransactions({
      walletIds: input.treasuryWalletId,
    });
    const matchingTransaction = findMatchingCirclePayoutTransaction(
      response,
      input.payout as Parameters<typeof findMatchingCirclePayoutTransaction>[1],
      input.treasuryWalletId,
      input.tokenAddresses,
    );
    const txHash = extractCircleTransactionHash(matchingTransaction);

    if (!txHash) {
      return null;
    }

    const transactionId =
      extractCircleTransactionId(matchingTransaction) ??
      input.existingTransactionId ??
      null;
    const providerStatus =
      getNestedString(matchingTransaction, ['state']) ??
      getNestedString(matchingTransaction, ['status']) ??
      '';

    return {
      transactionId,
      txHash,
      providerStatus,
      snapshot: {
        provider: 'circle',
        transactionId,
        txHash,
        providerStatus: providerStatus || undefined,
        resolvedTransaction: sanitizeAppWalletSwapPayload(matchingTransaction),
        observedAt: new Date().toISOString(),
      },
    };
  }
}
