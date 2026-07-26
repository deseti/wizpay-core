import { removeSensitiveAppWalletSwapFields } from './app-wallet-swap-payload-sanitizer';
import {
  AppWalletSwapOperationResponse,
  AppWalletSwapQuoteResponse,
} from './app-wallet-swap.types';

const PUBLIC_QUOTE_FIELDS = [
  'operationMode',
  'sourceChain',
  'tokenIn',
  'tokenOut',
  'amountIn',
  'treasuryDepositAddress',
  'expectedOutput',
  'minimumOutput',
  'expiresAt',
  'status',
  'provider',
  'quoteId',
] as const satisfies readonly (keyof AppWalletSwapQuoteResponse)[];

const PUBLIC_OPERATION_FIELDS = [
  'operationId',
  'operationMode',
  'sourceChain',
  'tokenIn',
  'tokenOut',
  'amountIn',
  'userWalletAddress',
  'treasuryDepositAddress',
  'expectedOutput',
  'minimumOutput',
  'expiresAt',
  'status',
  'provider',
  'quoteId',
  'circleWalletId',
  'depositTxHash',
  'circleTransactionId',
  'circleReferenceId',
  'depositSubmittedAt',
  'depositConfirmedAt',
  'depositConfirmedAmount',
  'depositConfirmationError',
  'treasurySwapId',
  'treasurySwapQuoteId',
  'treasurySwapTxHash',
  'treasurySwapSubmittedAt',
  'treasurySwapConfirmedAt',
  'treasurySwapExpectedOutput',
  'treasurySwapActualOutput',
  'stablefxFundingRequestedAt',
  'stablefxFundedAt',
  'payoutTxHash',
  'payoutAmount',
  'payoutSubmittedAt',
  'payoutConfirmedAt',
  'refundTransactionId',
  'refundTxHash',
  'refundAmount',
  'refundSubmittedAt',
  'refundConfirmedAt',
  'completedAt',
  'executionError',
  'createdAt',
  'updatedAt',
  'executionEnabled',
] as const satisfies readonly (keyof AppWalletSwapOperationResponse)[];

function pickOwnEnumerableFields<T extends object, K extends keyof T>(
  source: T,
  fields: readonly K[],
): Pick<T, K> {
  return Object.fromEntries(
    fields.flatMap((field) =>
      Object.prototype.propertyIsEnumerable.call(source, field)
        ? [[field, source[field]]]
        : [],
    ),
  ) as Pick<T, K>;
}

export function toPublicAppWalletSwapOperation(
  operation: AppWalletSwapOperationResponse,
): AppWalletSwapOperationResponse {
  return removeSensitiveAppWalletSwapFields(
    pickOwnEnumerableFields(operation, PUBLIC_OPERATION_FIELDS),
  ) as AppWalletSwapOperationResponse;
}

export function toPublicAppWalletSwapQuote(
  quote: AppWalletSwapQuoteResponse,
): AppWalletSwapQuoteResponse {
  return removeSensitiveAppWalletSwapFields(
    pickOwnEnumerableFields(quote, PUBLIC_QUOTE_FIELDS),
  ) as AppWalletSwapQuoteResponse;
}
