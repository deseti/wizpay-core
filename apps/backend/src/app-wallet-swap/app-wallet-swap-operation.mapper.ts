import { AppWalletSwapOperation } from '@prisma/client';
import {
  AppWalletSwapOperationResponse,
  AppWalletSwapQuoteResponse,
  AppWalletSwapToken,
} from './app-wallet-swap.types';
import { removeSensitiveAppWalletSwapFields } from './app-wallet-swap-payload-sanitizer';

export function mapAppWalletSwapOperationRecord(
  record: AppWalletSwapOperation,
  fallbackProvider?: 'swapkit' | 'stablefx',
): AppWalletSwapOperationResponse {
  const rawQuote = record.rawQuote;
  const persistedProvider =
    typeof rawQuote === 'object' &&
    rawQuote !== null &&
    !Array.isArray(rawQuote) &&
    (rawQuote.provider === 'stablefx' || rawQuote.provider === 'swapkit')
      ? rawQuote.provider
      : undefined;
  const provider = persistedProvider ?? fallbackProvider;

  return {
    operationId: record.operationId,
    operationMode:
      record.operationMode as AppWalletSwapOperationResponse['operationMode'],
    sourceChain:
      record.sourceChain as AppWalletSwapOperationResponse['sourceChain'],
    tokenIn: record.tokenIn as AppWalletSwapToken,
    tokenOut: record.tokenOut as AppWalletSwapToken,
    amountIn: record.amountIn,
    userWalletAddress: record.userWalletAddress,
    treasuryDepositAddress: record.treasuryDepositAddress,
    expectedOutput: record.expectedOutput,
    minimumOutput: record.minimumOutput,
    expiresAt: record.expiresAt,
    status: record.status as AppWalletSwapOperationResponse['status'],
    ...(provider ? { provider } : {}),
    ...(record.quoteId !== null ? { quoteId: record.quoteId } : {}),
    ...(record.rawQuote !== null ? { rawQuote: record.rawQuote } : {}),
    ...(record.depositTxHash ? { depositTxHash: record.depositTxHash } : {}),
    ...(record.circleTransactionId
      ? { circleTransactionId: record.circleTransactionId }
      : {}),
    ...(record.circleReferenceId
      ? { circleReferenceId: record.circleReferenceId }
      : {}),
    ...(record.circleWalletId ? { circleWalletId: record.circleWalletId } : {}),
    ...(record.depositSubmittedAt
      ? { depositSubmittedAt: record.depositSubmittedAt.toISOString() }
      : {}),
    ...(record.depositConfirmedAt
      ? { depositConfirmedAt: record.depositConfirmedAt.toISOString() }
      : {}),
    ...(record.depositConfirmedAmount
      ? { depositConfirmedAmount: record.depositConfirmedAmount }
      : {}),
    ...(record.depositConfirmationError
      ? { depositConfirmationError: record.depositConfirmationError }
      : {}),
    ...(record.treasurySwapId ? { treasurySwapId: record.treasurySwapId } : {}),
    ...(record.treasurySwapQuoteId
      ? { treasurySwapQuoteId: record.treasurySwapQuoteId }
      : {}),
    ...(record.treasurySwapTxHash
      ? { treasurySwapTxHash: record.treasurySwapTxHash }
      : {}),
    ...(record.treasurySwapSubmittedAt
      ? {
          treasurySwapSubmittedAt: record.treasurySwapSubmittedAt.toISOString(),
        }
      : {}),
    ...(record.treasurySwapConfirmedAt
      ? {
          treasurySwapConfirmedAt: record.treasurySwapConfirmedAt.toISOString(),
        }
      : {}),
    ...(record.treasurySwapExpectedOutput !== null
      ? { treasurySwapExpectedOutput: record.treasurySwapExpectedOutput }
      : {}),
    ...(record.treasurySwapActualOutput
      ? { treasurySwapActualOutput: record.treasurySwapActualOutput }
      : {}),
    ...(record.rawTreasurySwap !== null
      ? { rawTreasurySwap: record.rawTreasurySwap }
      : {}),
    ...(record.stablefxFundingRequestedAt
      ? {
          stablefxFundingRequestedAt:
            record.stablefxFundingRequestedAt.toISOString(),
        }
      : {}),
    ...(record.stablefxFundedAt
      ? { stablefxFundedAt: record.stablefxFundedAt.toISOString() }
      : {}),
    ...(record.payoutTxHash ? { payoutTxHash: record.payoutTxHash } : {}),
    ...(record.payoutAmount ? { payoutAmount: record.payoutAmount } : {}),
    ...(record.payoutSubmittedAt
      ? { payoutSubmittedAt: record.payoutSubmittedAt.toISOString() }
      : {}),
    ...(record.payoutConfirmedAt
      ? { payoutConfirmedAt: record.payoutConfirmedAt.toISOString() }
      : {}),
    ...(record.rawPayout !== null ? { rawPayout: record.rawPayout } : {}),
    ...(record.refundTransactionId
      ? { refundTransactionId: record.refundTransactionId }
      : {}),
    ...(record.refundTxHash ? { refundTxHash: record.refundTxHash } : {}),
    ...(record.refundAmount ? { refundAmount: record.refundAmount } : {}),
    ...(record.refundSubmittedAt
      ? { refundSubmittedAt: record.refundSubmittedAt.toISOString() }
      : {}),
    ...(record.refundConfirmedAt
      ? { refundConfirmedAt: record.refundConfirmedAt.toISOString() }
      : {}),
    ...(record.rawRefund !== null ? { rawRefund: record.rawRefund } : {}),
    ...(record.completedAt
      ? { completedAt: record.completedAt.toISOString() }
      : {}),
    ...(record.executionError ? { executionError: record.executionError } : {}),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    executionEnabled: record.executionEnabled,
  };
}

export function toPublicAppWalletSwapOperation(
  operation: AppWalletSwapOperationResponse,
): AppWalletSwapOperationResponse {
  const {
    rawQuote: _rawQuote,
    rawTreasurySwap: _rawTreasurySwap,
    rawPayout: _rawPayout,
    rawRefund: _rawRefund,
    ...publicOperation
  } = operation;

  return removeSensitiveAppWalletSwapFields(
    publicOperation,
  ) as AppWalletSwapOperationResponse;
}

export function toPublicAppWalletSwapQuote(
  quote: AppWalletSwapQuoteResponse,
): AppWalletSwapQuoteResponse {
  const { rawQuote: _rawQuote, ...publicQuote } = quote;

  return removeSensitiveAppWalletSwapFields(
    publicQuote,
  ) as AppWalletSwapQuoteResponse;
}
