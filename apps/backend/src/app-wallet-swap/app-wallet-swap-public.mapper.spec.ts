import {
  toPublicAppWalletSwapOperation,
  toPublicAppWalletSwapQuote,
} from './app-wallet-swap-public.mapper';
import {
  APP_WALLET_SWAP_CHAIN,
  APP_WALLET_SWAP_MODE,
  AppWalletSwapOperationResponse,
  AppWalletSwapQuoteResponse,
} from './app-wallet-swap.types';

const TRANSACTION_HASH =
  '0xaa019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5';

function createQuote(
  overrides: Partial<AppWalletSwapQuoteResponse> = {},
): AppWalletSwapQuoteResponse {
  return {
    operationMode: APP_WALLET_SWAP_MODE,
    sourceChain: APP_WALLET_SWAP_CHAIN,
    tokenIn: 'EURC',
    tokenOut: 'USDC',
    amountIn: '17000000',
    treasuryDepositAddress: '0x1111111111111111111111111111111111111111',
    expectedOutput: '16000000',
    minimumOutput: '15900000',
    expiresAt: '2099-01-01T00:00:00.000Z',
    status: 'quoted',
    provider: 'stablefx',
    quoteId: 'quote-1',
    rawQuote: { providerPayload: 'private' },
    ...overrides,
  };
}

function createOperation(
  overrides: Partial<AppWalletSwapOperationResponse> = {},
): AppWalletSwapOperationResponse {
  return {
    ...createQuote(),
    operationId: '11111111-1111-4111-8111-111111111111',
    status: 'completed',
    userWalletAddress: '0x2222222222222222222222222222222222222222',
    circleWalletId: 'circle-wallet-1',
    depositTxHash: TRANSACTION_HASH,
    circleTransactionId: 'circle-transaction-1',
    circleReferenceId: 'circle-reference-1',
    depositSubmittedAt: '2099-01-01T00:00:01.000Z',
    depositConfirmedAt: '2099-01-01T00:00:02.000Z',
    depositConfirmedAmount: '17000000',
    depositConfirmationError: 'public retry guidance',
    treasurySwapId: 'treasury-swap-1',
    treasurySwapQuoteId: 'treasury-quote-1',
    treasurySwapTxHash: TRANSACTION_HASH,
    treasurySwapSubmittedAt: '2099-01-01T00:00:03.000Z',
    treasurySwapConfirmedAt: '2099-01-01T00:00:04.000Z',
    treasurySwapExpectedOutput: '16000000',
    treasurySwapActualOutput: '16000000',
    rawTreasurySwap: { providerPayload: 'private' },
    stablefxFundingRequestedAt: '2099-01-01T00:00:03.000Z',
    stablefxFundedAt: '2099-01-01T00:00:04.000Z',
    payoutTxHash: TRANSACTION_HASH,
    payoutAmount: '16000000',
    payoutSubmittedAt: '2099-01-01T00:00:05.000Z',
    payoutConfirmedAt: '2099-01-01T00:00:06.000Z',
    rawPayout: { providerPayload: 'private' },
    refundTransactionId: 'refund-transaction-1',
    refundTxHash: TRANSACTION_HASH,
    refundAmount: '17000000',
    refundSubmittedAt: '2099-01-01T00:00:07.000Z',
    refundConfirmedAt: '2099-01-01T00:00:08.000Z',
    rawRefund: { providerPayload: 'private' },
    completedAt: '2099-01-01T00:00:09.000Z',
    executionError: 'public execution error',
    createdAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2099-01-01T00:00:09.000Z',
    executionEnabled: true,
    provider: 'stablefx',
    ...overrides,
  };
}

describe('App Wallet swap public mapper', () => {
  it('preserves the exact declared operation response while withholding raw payloads', () => {
    const operation = createOperation();
    const result = toPublicAppWalletSwapOperation(operation);

    expect(result).toEqual({
      operationId: operation.operationId,
      operationMode: operation.operationMode,
      sourceChain: operation.sourceChain,
      tokenIn: operation.tokenIn,
      tokenOut: operation.tokenOut,
      amountIn: operation.amountIn,
      userWalletAddress: operation.userWalletAddress,
      treasuryDepositAddress: operation.treasuryDepositAddress,
      expectedOutput: operation.expectedOutput,
      minimumOutput: operation.minimumOutput,
      expiresAt: operation.expiresAt,
      status: operation.status,
      provider: operation.provider,
      quoteId: operation.quoteId,
      circleWalletId: operation.circleWalletId,
      depositTxHash: operation.depositTxHash,
      circleTransactionId: operation.circleTransactionId,
      circleReferenceId: operation.circleReferenceId,
      depositSubmittedAt: operation.depositSubmittedAt,
      depositConfirmedAt: operation.depositConfirmedAt,
      depositConfirmedAmount: operation.depositConfirmedAmount,
      depositConfirmationError: operation.depositConfirmationError,
      treasurySwapId: operation.treasurySwapId,
      treasurySwapQuoteId: operation.treasurySwapQuoteId,
      treasurySwapTxHash: operation.treasurySwapTxHash,
      treasurySwapSubmittedAt: operation.treasurySwapSubmittedAt,
      treasurySwapConfirmedAt: operation.treasurySwapConfirmedAt,
      treasurySwapExpectedOutput: operation.treasurySwapExpectedOutput,
      treasurySwapActualOutput: operation.treasurySwapActualOutput,
      stablefxFundingRequestedAt: operation.stablefxFundingRequestedAt,
      stablefxFundedAt: operation.stablefxFundedAt,
      payoutTxHash: operation.payoutTxHash,
      payoutAmount: operation.payoutAmount,
      payoutSubmittedAt: operation.payoutSubmittedAt,
      payoutConfirmedAt: operation.payoutConfirmedAt,
      refundTransactionId: operation.refundTransactionId,
      refundTxHash: operation.refundTxHash,
      refundAmount: operation.refundAmount,
      refundSubmittedAt: operation.refundSubmittedAt,
      refundConfirmedAt: operation.refundConfirmedAt,
      completedAt: operation.completedAt,
      executionError: operation.executionError,
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
      executionEnabled: operation.executionEnabled,
    });
    expect(result).not.toHaveProperty('rawQuote');
    expect(result).not.toHaveProperty('rawTreasurySwap');
    expect(result).not.toHaveProperty('rawPayout');
    expect(result).not.toHaveProperty('rawRefund');
  });

  it('preserves the quote response and provider while removing raw quote data', () => {
    const quote = createQuote();

    expect(toPublicAppWalletSwapQuote(quote)).toEqual({
      operationMode: quote.operationMode,
      sourceChain: quote.sourceChain,
      tokenIn: quote.tokenIn,
      tokenOut: quote.tokenOut,
      amountIn: quote.amountIn,
      treasuryDepositAddress: quote.treasuryDepositAddress,
      expectedOutput: quote.expectedOutput,
      minimumOutput: quote.minimumOutput,
      expiresAt: quote.expiresAt,
      status: quote.status,
      provider: 'stablefx',
      quoteId: 'quote-1',
    });
  });

  it('excludes raw provider payloads and sensitive undeclared fields', () => {
    const operation = {
      ...createOperation({
        rawQuote: {
          apiKey: 'quote-api-key',
          signature: 'quote-signature',
        },
        rawTreasurySwap: {
          authorization: 'treasury-authorization',
        },
        rawPayout: {
          rawCircleResponse: { accessToken: 'circle-access-token' },
        },
        rawRefund: {
          signedPayload: 'refund-signed-payload',
        },
      }),
      apiKey: 'top-level-api-key',
      signature: 'top-level-signature',
      authorization: 'top-level-authorization',
      executionLeaseId: 'internal-lease-id',
      executionLeaseExpiresAt: '2099-01-01T01:00:00.000Z',
      diagnostic: { providerResponse: 'internal-diagnostic' },
    } as AppWalletSwapOperationResponse & Record<string, unknown>;

    const serialized = JSON.stringify(
      toPublicAppWalletSwapOperation(operation),
    );

    expect(serialized).not.toContain('api-key');
    expect(serialized).not.toContain('signature');
    expect(serialized).not.toContain('authorization');
    expect(serialized).not.toContain('access-token');
    expect(serialized).not.toContain('signed-payload');
    expect(serialized).not.toContain('internal-lease');
    expect(serialized).not.toContain('internal-diagnostic');
  });

  it('preserves null and explicitly undefined optional fields', () => {
    const operation = createOperation({
      quoteId: null,
      payoutTxHash: undefined,
      depositConfirmationError: undefined,
    });
    const result = toPublicAppWalletSwapOperation(operation);

    expect(result).toHaveProperty('quoteId', null);
    expect(result).toHaveProperty('payoutTxHash', undefined);
    expect(result).toHaveProperty('depositConfirmationError', undefined);
  });

  it('handles partial malformed stored shapes without throwing', () => {
    const partial = {
      operationId: 'partial-operation',
      status: 'deposit_submitted',
      rawQuote: 'malformed',
      rawTreasurySwap: ['malformed'],
      executionLeaseId: 'internal-lease-id',
    } as unknown as AppWalletSwapOperationResponse;

    expect(() => toPublicAppWalletSwapOperation(partial)).not.toThrow();
    expect(toPublicAppWalletSwapOperation(partial)).toEqual({
      operationId: 'partial-operation',
      status: 'deposit_submitted',
    });
  });

  it('does not mutate source quote or operation objects', () => {
    const quote = createQuote();
    const operation = createOperation();
    const quoteBefore = structuredClone(quote);
    const operationBefore = structuredClone(operation);

    toPublicAppWalletSwapQuote(quote);
    toPublicAppWalletSwapOperation(operation);

    expect(quote).toEqual(quoteBefore);
    expect(operation).toEqual(operationBefore);
  });

  it('remains compatible with the controller data envelope', () => {
    const operation = toPublicAppWalletSwapOperation(createOperation());

    expect({ data: operation }).toEqual({
      data: expect.objectContaining({
        operationId: '11111111-1111-4111-8111-111111111111',
        provider: 'stablefx',
        status: 'completed',
      }),
    });
  });
});
