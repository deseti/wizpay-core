import {
  APP_WALLET_SWAP_CHAIN,
  AppWalletSwapOperationResponse,
  AppWalletSwapToken,
} from './app-wallet-swap.types';
import {
  describeAppWalletSwapPayloadShape,
  sanitizeAppWalletSwapPayload,
} from './app-wallet-swap-payload-sanitizer';
import {
  extractCircleTransactionHash,
  getNestedString,
  getNestedValue,
} from './app-wallet-swap-provider-reference';

const CIRCLE_TOKEN_ID_BY_SYMBOL: Record<AppWalletSwapToken, string> = {
  USDC: '15dc2b5d-0994-58b0-bf8c-3a0501148ee8',
  EURC: '4ea52a96-e6ae-56dc-8336-385bb238755f',
};
const TOKEN_DECIMALS_BY_SYMBOL: Record<AppWalletSwapToken, number> = {
  USDC: 6,
  EURC: 6,
};
const CIRCLE_TRANSACTION_TIME_TOLERANCE_MS = 10_000;

export type AppWalletSwapTokenAddresses = Record<AppWalletSwapToken, string>;

export interface CircleDepositTransactionMatch {
  transaction: unknown;
  destinationAddressMissing: boolean;
}

export function extractCircleTransactions(value: unknown): unknown[] {
  const candidates = [
    getNestedValue(value, ['data', 'transactions']),
    getNestedValue(value, ['transactions']),
    getNestedValue(value, ['data', 'transaction']),
    getNestedValue(value, ['transaction']),
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }

    if (candidate && typeof candidate === 'object') {
      return [candidate];
    }
  }

  return [];
}

export function findMatchingCircleDepositTransaction(
  value: unknown,
  operation: AppWalletSwapOperationResponse,
  tokenAddresses: AppWalletSwapTokenAddresses,
): CircleDepositTransactionMatch | null {
  const transaction = extractCircleTransactions(value).find((candidate) =>
    matchesCircleDepositTransaction(candidate, operation, tokenAddresses),
  );

  return transaction === undefined
    ? null
    : {
        transaction,
        destinationAddressMissing:
          getTransactionDestinationAddress(transaction) === null,
      };
}

export function findMatchingCirclePayoutTransaction(
  value: unknown,
  operation: AppWalletSwapOperationResponse,
  treasuryWalletId: string,
  tokenAddresses: AppWalletSwapTokenAddresses,
): unknown {
  return extractCircleTransactions(value).find((transaction) =>
    matchesCirclePayoutTransaction(
      transaction,
      operation,
      treasuryWalletId,
      tokenAddresses,
    ),
  );
}

export function buildDepositResolutionDiagnostic(
  value: unknown,
  operation: AppWalletSwapOperationResponse,
  tokenAddresses: AppWalletSwapTokenAddresses,
): string | null {
  if (operation.tokenIn !== 'EURC') {
    return null;
  }

  const transactions = extractCircleTransactions(value);

  if (transactions.length === 0) {
    return null;
  }

  const candidates = transactions.slice(0, 5).map((transaction) =>
    sanitizeAppWalletSwapPayload({
      shape: describeAppWalletSwapPayloadShape(transaction),
      id: getNestedString(transaction, ['id']),
      blockchain: getNestedString(transaction, ['blockchain']),
      walletId: getNestedString(transaction, ['walletId']),
      sourceAddress: getTransactionSourceAddress(transaction),
      destinationAddress: getTransactionDestinationAddress(transaction),
      state: getNestedString(transaction, ['state']),
      operation: getNestedString(transaction, ['operation']),
      transactionType: getNestedString(transaction, ['transactionType']),
      token: getNestedString(transaction, ['token']),
      tokenSymbol: getNestedString(transaction, ['tokenSymbol']),
      assetSymbol: getNestedString(transaction, ['assetSymbol']),
      tokenId: getNestedString(transaction, ['tokenId']),
      contractAddress: getNestedString(transaction, ['contractAddress']),
      tokenAddress: getNestedString(transaction, ['tokenAddress']),
      amount:
        getNestedString(transaction, ['amount']) ??
        getNestedString(transaction, ['value']) ??
        firstStringFromArray(getNestedValue(transaction, ['amounts'])),
      createDate:
        getNestedString(transaction, ['createDate']) ??
        getNestedString(transaction, ['createdAt']) ??
        getNestedString(transaction, ['submittedAt']),
      hasTxHash: Boolean(extractCircleTransactionHash(transaction)),
      rejectionReasons: getDepositTransactionRejectionReasons(
        transaction,
        operation,
        tokenAddresses,
      ),
    }),
  );

  return JSON.stringify({
    expectedToken: operation.tokenIn,
    expectedAmount: operation.amountIn,
    expectedDestination: operation.treasuryDepositAddress,
    expectedWalletId: operation.circleWalletId ?? null,
    candidateCount: transactions.length,
    candidates,
  });
}

export function matchesCircleDepositTransaction(
  transaction: unknown,
  operation: AppWalletSwapOperationResponse,
  tokenAddresses: AppWalletSwapTokenAddresses,
): boolean {
  if (!transaction || typeof transaction !== 'object') {
    return false;
  }

  if (!extractCircleTransactionHash(transaction)) {
    return false;
  }

  if (
    !equalsIgnoreCase(
      getNestedString(transaction, ['blockchain']),
      APP_WALLET_SWAP_CHAIN,
    )
  ) {
    return false;
  }

  if (!transactionDestinationMatchesDepositTarget(transaction, operation)) {
    return false;
  }

  if (
    !transactionMatchesDepositToken(
      transaction,
      operation.tokenIn,
      tokenAddresses,
    )
  ) {
    return false;
  }

  if (
    !transactionAmountEquals(operation.amountIn, transaction, operation.tokenIn)
  ) {
    return false;
  }

  if (!transactionOccurredAfter(transaction, operation.depositSubmittedAt)) {
    return false;
  }

  if (!transactionHasAcceptableDepositTransferShape(transaction)) {
    return false;
  }

  if (!transactionMatchesDepositSource(transaction, operation)) {
    return false;
  }

  if (!transactionMatchesReference(transaction, operation)) {
    if (!transactionHasStrictFallbackMatch(transaction, operation)) {
      return false;
    }
  }

  const sourceAddress = getTransactionSourceAddress(transaction);

  if (
    sourceAddress &&
    !equalsIgnoreCase(sourceAddress, operation.userWalletAddress)
  ) {
    return false;
  }

  if (
    operation.circleWalletId &&
    !equalsIgnoreCase(
      getNestedString(transaction, ['walletId']),
      operation.circleWalletId,
    )
  ) {
    return false;
  }

  return true;
}

export function matchesCirclePayoutTransaction(
  transaction: unknown,
  operation: AppWalletSwapOperationResponse,
  treasuryWalletId: string,
  tokenAddresses: AppWalletSwapTokenAddresses,
): boolean {
  if (!transaction || typeof transaction !== 'object') {
    return false;
  }

  if (!extractCircleTransactionHash(transaction)) {
    return false;
  }

  if (
    !equalsIgnoreCase(
      getNestedString(transaction, ['blockchain']),
      APP_WALLET_SWAP_CHAIN,
    )
  ) {
    return false;
  }

  if (
    !equalsIgnoreCase(
      getNestedString(transaction, ['walletId']),
      treasuryWalletId,
    )
  ) {
    return false;
  }

  const sourceAddress = getTransactionSourceAddress(transaction);

  if (
    sourceAddress &&
    !equalsIgnoreCase(sourceAddress, operation.treasuryDepositAddress)
  ) {
    return false;
  }

  if (
    !addressMatchesAny(transaction, operation.userWalletAddress, [
      ['destinationAddress'],
      ['destination', 'address'],
      ['toAddress'],
      ['to'],
    ])
  ) {
    return false;
  }

  if (
    !transactionMatchesDepositToken(
      transaction,
      operation.tokenOut,
      tokenAddresses,
    )
  ) {
    return false;
  }

  if (
    !transactionAmountEquals(
      operation.payoutAmount,
      transaction,
      operation.tokenOut,
    )
  ) {
    return false;
  }

  if (!transactionHasCompleteOutboundTransferShape(transaction)) {
    return false;
  }

  return transactionOccurredAfter(transaction, operation.payoutSubmittedAt);
}

export function transactionMatchesDepositSource(
  transaction: unknown,
  operation: AppWalletSwapOperationResponse,
): boolean {
  const walletId = getNestedString(transaction, ['walletId']);
  const sourceAddress = getTransactionSourceAddress(transaction);

  if (operation.circleWalletId && walletId) {
    return (
      equalsIgnoreCase(walletId, operation.circleWalletId) &&
      (!sourceAddress ||
        equalsIgnoreCase(sourceAddress, operation.userWalletAddress))
    );
  }

  return Boolean(
    sourceAddress &&
    equalsIgnoreCase(sourceAddress, operation.userWalletAddress),
  );
}

export function transactionDestinationMatchesDepositTarget(
  transaction: unknown,
  operation: AppWalletSwapOperationResponse,
): boolean {
  const destinationAddress = getTransactionDestinationAddress(transaction);

  return (
    !destinationAddress ||
    equalsIgnoreCase(destinationAddress, operation.treasuryDepositAddress)
  );
}

export function transactionHasStrictFallbackMatch(
  transaction: unknown,
  operation: AppWalletSwapOperationResponse,
): boolean {
  const sourceAddress = getTransactionSourceAddress(transaction);
  const walletId = getNestedString(transaction, ['walletId']);

  return (
    transactionHasAcceptableDepositTransferShape(transaction) &&
    (!operation.circleWalletId ||
      equalsIgnoreCase(walletId, operation.circleWalletId)) &&
    (!sourceAddress ||
      equalsIgnoreCase(sourceAddress, operation.userWalletAddress))
  );
}

export function getDepositTransactionRejectionReasons(
  transaction: unknown,
  operation: AppWalletSwapOperationResponse,
  tokenAddresses: AppWalletSwapTokenAddresses,
): string[] {
  const reasons: string[] = [];
  const walletId = getNestedString(transaction, ['walletId']);
  const sourceAddress = getTransactionSourceAddress(transaction);
  const destinationAddress = getTransactionDestinationAddress(transaction);

  if (!extractCircleTransactionHash(transaction)) {
    reasons.push('missing txHash');
  }

  if (
    !equalsIgnoreCase(
      getNestedString(transaction, ['blockchain']),
      APP_WALLET_SWAP_CHAIN,
    )
  ) {
    reasons.push('chain mismatch');
  }

  if (
    operation.circleWalletId &&
    walletId &&
    !equalsIgnoreCase(walletId, operation.circleWalletId)
  ) {
    reasons.push('address mismatch: walletId');
  }

  if (
    sourceAddress &&
    !equalsIgnoreCase(sourceAddress, operation.userWalletAddress)
  ) {
    reasons.push('address mismatch: sourceAddress');
  }

  if (
    destinationAddress &&
    !equalsIgnoreCase(destinationAddress, operation.treasuryDepositAddress)
  ) {
    reasons.push('address mismatch: destinationAddress');
  }

  if (
    !transactionMatchesDepositToken(
      transaction,
      operation.tokenIn,
      tokenAddresses,
    )
  ) {
    reasons.push('token mismatch');
  }

  if (
    !transactionAmountEquals(operation.amountIn, transaction, operation.tokenIn)
  ) {
    reasons.push('amount mismatch');
  }

  if (!transactionOccurredAfter(transaction, operation.depositSubmittedAt)) {
    reasons.push('timestamp mismatch');
  }

  if (!transactionHasAcceptableDepositTransferShape(transaction)) {
    const state = getNestedString(transaction, ['state']);
    const operationType = getNestedString(transaction, ['operation']);
    const transactionType = getNestedString(transaction, ['transactionType']);

    if (state && !isResolvableDepositTransactionState(state)) {
      reasons.push('state mismatch');
    }

    if (operationType && !equalsIgnoreCase(operationType, 'TRANSFER')) {
      reasons.push('operation mismatch');
    }

    if (transactionType && !equalsIgnoreCase(transactionType, 'OUTBOUND')) {
      reasons.push('transactionType mismatch');
    }
  }

  return reasons;
}

export function transactionMatchesReference(
  transaction: unknown,
  operation: AppWalletSwapOperationResponse,
): boolean {
  const txId = getNestedString(transaction, ['id']);
  const refId = getNestedString(transaction, ['refId']);

  if (
    operation.circleTransactionId &&
    equalsIgnoreCase(txId, operation.circleTransactionId)
  ) {
    return true;
  }

  if (
    operation.circleReferenceId &&
    (equalsIgnoreCase(refId, operation.circleReferenceId) ||
      equalsIgnoreCase(txId, operation.circleReferenceId))
  ) {
    return true;
  }

  return false;
}

export function transactionMatchesDepositToken(
  transaction: unknown,
  token: AppWalletSwapToken,
  tokenAddresses: AppWalletSwapTokenAddresses,
): boolean {
  const tokenAddress = tokenAddresses[token];
  const circleTokenId = CIRCLE_TOKEN_ID_BY_SYMBOL[token];
  const transactionTokenId = getNestedString(transaction, ['tokenId']);

  if (transactionTokenId) {
    return equalsIgnoreCase(transactionTokenId, circleTokenId);
  }

  return (
    equalsIgnoreCase(getNestedString(transaction, ['token']), token) ||
    equalsIgnoreCase(
      getNestedString(transaction, ['token', 'symbol']),
      token,
    ) ||
    equalsIgnoreCase(getNestedString(transaction, ['tokenSymbol']), token) ||
    equalsIgnoreCase(getNestedString(transaction, ['assetSymbol']), token) ||
    equalsIgnoreCase(
      getNestedString(transaction, ['asset', 'symbol']),
      token,
    ) ||
    equalsIgnoreCase(getNestedString(transaction, ['currency']), token) ||
    equalsIgnoreCase(
      getNestedString(transaction, ['contractAddress']),
      tokenAddress,
    ) ||
    equalsIgnoreCase(
      getNestedString(transaction, ['token', 'contractAddress']),
      tokenAddress,
    ) ||
    equalsIgnoreCase(
      getNestedString(transaction, ['tokenAddress']),
      tokenAddress,
    ) ||
    equalsIgnoreCase(
      getNestedString(transaction, ['asset', 'address']),
      tokenAddress,
    )
  );
}

export function transactionAmountEquals(
  expectedAmount: string | undefined,
  transaction: unknown,
  token: AppWalletSwapToken = 'USDC',
): boolean {
  if (!expectedAmount) {
    return false;
  }

  const rawAmount =
    getNestedString(transaction, ['amount']) ??
    getNestedString(transaction, ['value']) ??
    firstStringFromArray(getNestedValue(transaction, ['amounts']));

  if (!rawAmount) {
    return false;
  }

  const normalizedAmount = normalizeCircleAmountToBaseUnits(
    rawAmount,
    expectedAmount,
    token,
  );

  return (
    normalizedAmount !== null && normalizedAmount === BigInt(expectedAmount)
  );
}

export function transactionOccurredAfter(
  transaction: unknown,
  submittedAt: string | undefined,
): boolean {
  if (!submittedAt) {
    return false;
  }

  const submittedTime = Date.parse(submittedAt);

  if (!Number.isFinite(submittedTime)) {
    return false;
  }

  const timestamp =
    getNestedString(transaction, ['createDate']) ??
    getNestedString(transaction, ['createdAt']) ??
    getNestedString(transaction, ['submittedAt']) ??
    getNestedString(transaction, ['updateDate']) ??
    getNestedString(transaction, ['updatedAt']);

  if (!timestamp) {
    return false;
  }

  const transactionTime = Date.parse(timestamp);

  return (
    Number.isFinite(transactionTime) &&
    transactionTime + CIRCLE_TRANSACTION_TIME_TOLERANCE_MS >= submittedTime
  );
}

export function transactionHasCompleteOutboundTransferShape(
  transaction: unknown,
): boolean {
  return (
    equalsIgnoreCase(getNestedString(transaction, ['state']), 'COMPLETE') &&
    equalsIgnoreCase(getNestedString(transaction, ['operation']), 'TRANSFER') &&
    equalsIgnoreCase(
      getNestedString(transaction, ['transactionType']),
      'OUTBOUND',
    )
  );
}

export function transactionHasAcceptableDepositTransferShape(
  transaction: unknown,
): boolean {
  const state = getNestedString(transaction, ['state']);
  const operationType = getNestedString(transaction, ['operation']);
  const transactionType = getNestedString(transaction, ['transactionType']);

  return (
    (!state || isResolvableDepositTransactionState(state)) &&
    (!operationType || equalsIgnoreCase(operationType, 'TRANSFER')) &&
    (!transactionType || equalsIgnoreCase(transactionType, 'OUTBOUND'))
  );
}

export function isResolvableDepositTransactionState(state: string): boolean {
  return equalsIgnoreCase(state, 'COMPLETE') || equalsIgnoreCase(state, 'SENT');
}

export function isFailedCircleTransactionStatus(status: string): boolean {
  return ['FAILED', 'CANCELLED', 'DENIED'].includes(status);
}

export function getTransactionSourceAddress(
  transaction: unknown,
): string | null {
  return (
    getNestedString(transaction, ['sourceAddress']) ??
    getNestedString(transaction, ['source', 'address']) ??
    getNestedString(transaction, ['fromAddress']) ??
    getNestedString(transaction, ['from'])
  );
}

export function getTransactionDestinationAddress(
  transaction: unknown,
): string | null {
  return (
    getNestedString(transaction, ['destinationAddress']) ??
    getNestedString(transaction, ['destination', 'address']) ??
    getNestedString(transaction, ['toAddress']) ??
    getNestedString(transaction, ['to'])
  );
}

export function normalizeCircleAmountToBaseUnits(
  rawAmount: string,
  expectedBaseAmount: string,
  token: AppWalletSwapToken,
): bigint | null {
  const amount = rawAmount.trim();

  if (!amount) {
    return null;
  }

  if (/^\d+$/.test(amount) && amount === expectedBaseAmount) {
    return BigInt(amount);
  }

  return normalizeTokenAmountToBaseUnits(
    amount,
    TOKEN_DECIMALS_BY_SYMBOL[token],
  );
}

export function normalizeTokenAmountToBaseUnits(
  rawAmount: string,
  decimals: number,
): bigint | null {
  const amount = rawAmount.trim();

  if (!amount) {
    return null;
  }

  if (/^\d+$/.test(amount)) {
    return BigInt(amount) * 10n ** BigInt(decimals);
  }

  const match = amount.match(/^(\d*)\.(\d+)$/);

  if (!match) {
    return null;
  }

  const whole = match[1] || '0';
  const fraction = match[2].slice(0, decimals).padEnd(decimals, '0');

  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction);
}

export function equalsIgnoreCase(left: string | null, right: string): boolean {
  return left?.toLowerCase() === right.toLowerCase();
}

function addressMatchesAny(
  value: unknown,
  expectedAddress: string,
  paths: string[][],
): boolean {
  return paths.some((path) =>
    equalsIgnoreCase(getNestedString(value, path), expectedAddress),
  );
}

function firstStringFromArray(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const firstString = value.find(
    (item): item is string =>
      typeof item === 'string' && item.trim().length > 0,
  );

  return firstString?.trim() ?? null;
}
