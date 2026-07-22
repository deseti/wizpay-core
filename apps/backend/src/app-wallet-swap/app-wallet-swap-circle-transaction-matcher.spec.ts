import {
  AppWalletSwapTokenAddresses,
  buildDepositResolutionDiagnostic,
  equalsIgnoreCase,
  extractCircleTransactions,
  findMatchingCircleDepositTransaction,
  findMatchingCirclePayoutTransaction,
  getTransactionDestinationAddress,
  getTransactionSourceAddress,
  isFailedCircleTransactionStatus,
  isResolvableDepositTransactionState,
  matchesCircleDepositTransaction,
  matchesCirclePayoutTransaction,
  normalizeCircleAmountToBaseUnits,
  normalizeTokenAmountToBaseUnits,
  transactionAmountEquals,
  transactionHasAcceptableDepositTransferShape,
  transactionHasCompleteOutboundTransferShape,
  transactionMatchesDepositSource,
  transactionMatchesDepositToken,
  transactionMatchesReference,
  transactionOccurredAfter,
} from './app-wallet-swap-circle-transaction-matcher';
import {
  extractCircleTransactionHash,
  extractCircleTransactionId,
} from './app-wallet-swap-provider-reference';
import {
  APP_WALLET_SWAP_CHAIN,
  APP_WALLET_SWAP_MODE,
  AppWalletSwapOperationResponse,
} from './app-wallet-swap.types';

const USER_ADDRESS = '0x1111111111111111111111111111111111111111';
const TREASURY_ADDRESS = '0x2222222222222222222222222222222222222222';
const USDC_ADDRESS = '0x3333333333333333333333333333333333333333';
const EURC_ADDRESS = '0x4444444444444444444444444444444444444444';
const TRANSACTION_HASH =
  '0xaa019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5';
const SECOND_TRANSACTION_HASH =
  '0xbb019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5';
const SUBMITTED_AT = '2099-01-01T00:00:10.000Z';
const TOKEN_ADDRESSES: AppWalletSwapTokenAddresses = {
  USDC: USDC_ADDRESS,
  EURC: EURC_ADDRESS,
};

function createOperation(
  overrides: Partial<AppWalletSwapOperationResponse> = {},
): AppWalletSwapOperationResponse {
  return {
    operationId: '11111111-1111-4111-8111-111111111111',
    operationMode: APP_WALLET_SWAP_MODE,
    sourceChain: APP_WALLET_SWAP_CHAIN,
    tokenIn: 'EURC',
    tokenOut: 'USDC',
    amountIn: '1000000',
    treasuryDepositAddress: TREASURY_ADDRESS,
    userWalletAddress: USER_ADDRESS,
    expectedOutput: '1000000',
    minimumOutput: '990000',
    expiresAt: '2099-01-01T00:05:00.000Z',
    status: 'deposit_submitted',
    circleWalletId: 'circle-wallet-1',
    circleTransactionId: 'circle-transaction-1',
    circleReferenceId: 'circle-reference-1',
    depositSubmittedAt: SUBMITTED_AT,
    payoutAmount: '1000000',
    payoutSubmittedAt: SUBMITTED_AT,
    createdAt: '2099-01-01T00:00:00.000Z',
    updatedAt: SUBMITTED_AT,
    executionEnabled: true,
    ...overrides,
  };
}

function createDepositTransaction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'circle-transaction-1',
    refId: 'circle-reference-1',
    txHash: TRANSACTION_HASH,
    blockchain: APP_WALLET_SWAP_CHAIN,
    walletId: 'circle-wallet-1',
    sourceAddress: USER_ADDRESS,
    destinationAddress: TREASURY_ADDRESS,
    tokenSymbol: 'EURC',
    amount: '1',
    state: 'COMPLETE',
    operation: 'TRANSFER',
    transactionType: 'OUTBOUND',
    createDate: SUBMITTED_AT,
    ...overrides,
  };
}

function createPayoutTransaction(overrides: Record<string, unknown> = {}) {
  return {
    txHash: TRANSACTION_HASH,
    blockchain: APP_WALLET_SWAP_CHAIN,
    walletId: 'treasury-wallet-1',
    sourceAddress: TREASURY_ADDRESS,
    destinationAddress: USER_ADDRESS,
    tokenSymbol: 'USDC',
    amount: '1',
    state: 'COMPLETE',
    operation: 'TRANSFER',
    transactionType: 'OUTBOUND',
    createDate: SUBMITTED_AT,
    ...overrides,
  };
}

describe('App Wallet swap Circle transaction matcher', () => {
  it('preserves accepted transaction ID and hash shapes', () => {
    expect(extractCircleTransactionId({ id: ' arbitrary-provider-id ' })).toBe(
      'arbitrary-provider-id',
    );
    expect(
      extractCircleTransactionId({ data: { transaction: { txId: 'tx-1' } } }),
    ).toBe('tx-1');
    expect(
      extractCircleTransactionHash({
        data: { transaction: { transactionHash: TRANSACTION_HASH } },
      }),
    ).toBe(TRANSACTION_HASH);
  });

  it('rejects missing and malformed transaction IDs and hashes', () => {
    expect(extractCircleTransactionId(null)).toBeNull();
    expect(extractCircleTransactionId({ id: '   ' })).toBeNull();
    expect(extractCircleTransactionId({ id: { nested: true } })).toBeNull();
    expect(extractCircleTransactionHash({ txHash: '0x1234' })).toBeNull();
    expect(extractCircleTransactionHash({ txHash: 123 })).toBeNull();
  });

  it('compares addresses case-insensitively without adding EVM validation', () => {
    expect(equalsIgnoreCase(USER_ADDRESS.toUpperCase(), USER_ADDRESS)).toBe(
      true,
    );
    expect(equalsIgnoreCase('not-an-address', 'NOT-AN-ADDRESS')).toBe(true);
    expect(equalsIgnoreCase(null, USER_ADDRESS)).toBe(false);
  });

  it('extracts source and destination address aliases in current preference order', () => {
    const transaction = {
      sourceAddress: USER_ADDRESS,
      source: { address: TREASURY_ADDRESS },
      destination: { address: TREASURY_ADDRESS },
      toAddress: USER_ADDRESS,
    };

    expect(getTransactionSourceAddress(transaction)).toBe(USER_ADDRESS);
    expect(getTransactionDestinationAddress(transaction)).toBe(
      TREASURY_ADDRESS,
    );
    expect(getTransactionSourceAddress({ source: 'malformed' })).toBeNull();
  });

  it('preserves Circle wallet and source-address deposit matching', () => {
    const operation = createOperation();

    expect(
      transactionMatchesDepositSource(createDepositTransaction(), operation),
    ).toBe(true);
    expect(
      transactionMatchesDepositSource(
        createDepositTransaction({ walletId: 'wrong-wallet' }),
        operation,
      ),
    ).toBe(false);
    expect(
      transactionMatchesDepositSource(
        createDepositTransaction({ walletId: null }),
        operation,
      ),
    ).toBe(true);
  });

  it('matches Circle transaction and reference IDs case-insensitively', () => {
    const operation = createOperation();

    expect(
      transactionMatchesReference({ id: 'CIRCLE-TRANSACTION-1' }, operation),
    ).toBe(true);
    expect(
      transactionMatchesReference({ refId: 'CIRCLE-REFERENCE-1' }, operation),
    ).toBe(true);
    expect(transactionMatchesReference({}, operation)).toBe(false);
  });

  it('matches supported token IDs, symbols, and token addresses', () => {
    expect(
      transactionMatchesDepositToken(
        { tokenId: '4ea52a96-e6ae-56dc-8336-385bb238755f' },
        'EURC',
        TOKEN_ADDRESSES,
      ),
    ).toBe(true);
    expect(
      transactionMatchesDepositToken(
        { tokenSymbol: 'eurc' },
        'EURC',
        TOKEN_ADDRESSES,
      ),
    ).toBe(true);
    expect(
      transactionMatchesDepositToken(
        { tokenAddress: EURC_ADDRESS.toUpperCase() },
        'EURC',
        TOKEN_ADDRESSES,
      ),
    ).toBe(true);
    expect(
      transactionMatchesDepositToken(
        { tokenId: 'unknown-token-id', tokenSymbol: 'EURC' },
        'EURC',
        TOKEN_ADDRESSES,
      ),
    ).toBe(false);
  });

  it('requires the existing Arc Testnet blockchain value', () => {
    expect(
      matchesCircleDepositTransaction(
        createDepositTransaction({ blockchain: 'arc-testnet' }),
        createOperation(),
        TOKEN_ADDRESSES,
      ),
    ).toBe(true);
    expect(
      matchesCircleDepositTransaction(
        createDepositTransaction({ blockchain: 'ETH-SEPOLIA' }),
        createOperation(),
        TOKEN_ADDRESSES,
      ),
    ).toBe(false);
    expect(
      matchesCircleDepositTransaction(
        createDepositTransaction({ blockchain: null }),
        createOperation(),
        TOKEN_ADDRESSES,
      ),
    ).toBe(false);
  });

  it.each([
    ['exact base units', '1000000', '1000000', true],
    ['integer human units', '1', '1000000', true],
    ['decimal human units', '1.000000', '1000000', true],
    ['truncated extra precision', '1.0000009', '1000000', true],
    ['fraction only', '.5', '500000', true],
    ['negative', '-1', '1000000', false],
    ['trailing decimal point', '1.', '1000000', false],
    ['missing', null, '1000000', false],
    ['fractional mismatch', '0.999999', '1000000', false],
  ])('preserves %s amount behavior', (_, amount, expected, matches) => {
    expect(transactionAmountEquals(expected, { amount }, 'EURC')).toBe(matches);
  });

  it('parses oversized integers without floating-point conversion', () => {
    const oversized = '999999999999999999999999999999999999';

    expect(normalizeCircleAmountToBaseUnits(oversized, oversized, 'USDC')).toBe(
      BigInt(oversized),
    );
    expect(normalizeTokenAmountToBaseUnits('1', 6)).toBe(1_000_000n);
    expect(normalizeTokenAmountToBaseUnits('invalid', 6)).toBeNull();
  });

  it('includes the exact lower timestamp boundary and rejects just below it', () => {
    expect(
      transactionOccurredAfter(
        { createDate: '2099-01-01T00:00:00.000Z' },
        SUBMITTED_AT,
      ),
    ).toBe(true);
    expect(
      transactionOccurredAfter(
        { createDate: '2098-12-31T23:59:59.999Z' },
        SUBMITTED_AT,
      ),
    ).toBe(false);
  });

  it('preserves the absence of an upper timestamp bound', () => {
    expect(
      transactionOccurredAfter(
        { updatedAt: '2199-01-01T00:00:00.000Z' },
        SUBMITTED_AT,
      ),
    ).toBe(true);
    expect(transactionOccurredAfter({}, SUBMITTED_AT)).toBe(false);
    expect(
      transactionOccurredAfter({ createDate: 'malformed' }, SUBMITTED_AT),
    ).toBe(false);
    expect(
      transactionOccurredAfter({ createDate: SUBMITTED_AT }, 'malformed'),
    ).toBe(false);
  });

  it('preserves accepted, pending, failed, and malformed status behavior', () => {
    expect(isResolvableDepositTransactionState('complete')).toBe(true);
    expect(isResolvableDepositTransactionState('SENT')).toBe(true);
    expect(isResolvableDepositTransactionState('PENDING')).toBe(false);
    expect(isFailedCircleTransactionStatus('FAILED')).toBe(true);
    expect(isFailedCircleTransactionStatus('CANCELLED')).toBe(true);
    expect(isFailedCircleTransactionStatus('DENIED')).toBe(true);
    expect(isFailedCircleTransactionStatus('failed')).toBe(false);
    expect(isFailedCircleTransactionStatus('')).toBe(false);
  });

  it('preserves complete payout shape and permissive missing deposit shape', () => {
    expect(
      transactionHasCompleteOutboundTransferShape(createPayoutTransaction()),
    ).toBe(true);
    expect(
      transactionHasCompleteOutboundTransferShape(
        createPayoutTransaction({ state: 'PENDING' }),
      ),
    ).toBe(false);
    expect(transactionHasAcceptableDepositTransferShape({})).toBe(true);
    expect(
      transactionHasAcceptableDepositTransferShape({ state: 'PENDING' }),
    ).toBe(false);
  });

  it('selects direct and list response envelopes in existing precedence order', () => {
    const direct = createDepositTransaction();
    const listed = createDepositTransaction({
      txHash: SECOND_TRANSACTION_HASH,
    });

    expect(extractCircleTransactions({ transaction: direct })).toEqual([
      direct,
    ]);
    expect(
      extractCircleTransactions({ data: { transaction: direct } }),
    ).toEqual([direct]);
    expect(extractCircleTransactions({ transactions: [listed] })).toEqual([
      listed,
    ]);
    expect(
      extractCircleTransactions({
        data: { transactions: [] },
        transactions: [listed],
      }),
    ).toEqual([]);
    expect(extractCircleTransactions({ data: 'malformed' })).toEqual([]);
  });

  it('selects the first valid deposit candidate without reordering input', () => {
    const invalid = createDepositTransaction({ txHash: 'invalid' });
    const firstValid = createDepositTransaction();
    const secondValid = createDepositTransaction({
      txHash: SECOND_TRANSACTION_HASH,
    });
    const transactions = [invalid, firstValid, secondValid];
    const before = structuredClone(transactions);

    const match = findMatchingCircleDepositTransaction(
      { transactions },
      createOperation(),
      TOKEN_ADDRESSES,
    );

    expect(match?.transaction).toBe(firstValid);
    expect(transactions).toEqual(before);
    expect(transactions[0]).toBe(invalid);
  });

  it('preserves relaxed missing deposit destination behavior', () => {
    const transaction = createDepositTransaction({ destinationAddress: null });
    const match = findMatchingCircleDepositTransaction(
      { transactions: [transaction] },
      createOperation(),
      TOKEN_ADDRESSES,
    );

    expect(match).toEqual({
      transaction,
      destinationAddressMissing: true,
    });
  });

  it('matches payouts and selects the first valid list candidate', () => {
    const invalid = createPayoutTransaction({ walletId: 'wrong-wallet' });
    const valid = createPayoutTransaction();
    const operation = createOperation();

    expect(
      matchesCirclePayoutTransaction(
        valid,
        operation,
        'treasury-wallet-1',
        TOKEN_ADDRESSES,
      ),
    ).toBe(true);
    expect(
      findMatchingCirclePayoutTransaction(
        { data: { transactions: [invalid, valid] } },
        operation,
        'treasury-wallet-1',
        TOKEN_ADDRESSES,
      ),
    ).toBe(valid);
  });

  it('rejects malformed, incomplete, and mismatched deposit and payout candidates', () => {
    expect(
      matchesCircleDepositTransaction(null, createOperation(), TOKEN_ADDRESSES),
    ).toBe(false);
    expect(
      matchesCircleDepositTransaction(
        createDepositTransaction({ sourceAddress: TREASURY_ADDRESS }),
        createOperation(),
        TOKEN_ADDRESSES,
      ),
    ).toBe(false);
    expect(
      matchesCirclePayoutTransaction(
        createPayoutTransaction({ destinationAddress: null }),
        createOperation(),
        'treasury-wallet-1',
        TOKEN_ADDRESSES,
      ),
    ).toBe(false);
  });

  it('builds bounded safe diagnostics without including arbitrary candidate values', () => {
    const transactions = Array.from({ length: 7 }, (_, index) =>
      createDepositTransaction({
        id: `candidate-${index}`,
        tokenSymbol: 'UNKNOWN',
        internalNote: `not-public-${index}`,
      }),
    );

    const diagnostic = buildDepositResolutionDiagnostic(
      { transactions },
      createOperation(),
      TOKEN_ADDRESSES,
    );
    const parsed = JSON.parse(diagnostic ?? '{}') as {
      candidateCount: number;
      candidates: Array<Record<string, unknown>>;
    };

    expect(parsed.candidateCount).toBe(7);
    expect(parsed.candidates).toHaveLength(5);
    expect(parsed.candidates[0]).toMatchObject({
      id: 'candidate-0',
      rejectionReasons: ['token mismatch'],
    });
    expect(diagnostic).not.toContain('not-public-0');
    expect(
      buildDepositResolutionDiagnostic([], createOperation(), TOKEN_ADDRESSES),
    ).toBeNull();
    expect(
      buildDepositResolutionDiagnostic(
        { transactions },
        createOperation({ tokenIn: 'USDC' }),
        TOKEN_ADDRESSES,
      ),
    ).toBeNull();
  });

  it('does not mutate provider responses or operation inputs', () => {
    const transaction = createDepositTransaction();
    const response = { data: { transactions: [transaction] } };
    const operation = createOperation();
    const responseBefore = structuredClone(response);
    const operationBefore = structuredClone(operation);

    findMatchingCircleDepositTransaction(response, operation, TOKEN_ADDRESSES);
    buildDepositResolutionDiagnostic(response, operation, TOKEN_ADDRESSES);

    expect(response).toEqual(responseBefore);
    expect(operation).toEqual(operationBefore);
  });
});
