import {
  toPublicAppWalletSwapOperation,
  toPublicAppWalletSwapQuote,
} from './app-wallet-swap-operation.mapper';
import {
  removeSensitiveAppWalletSwapFields,
  sanitizeAppWalletSwapPayload,
} from './app-wallet-swap-payload-sanitizer';
import {
  extractCircleTransactionHash,
  extractCircleTransactionId,
  getPayoutTransactionHash,
  getPayoutTransactionId,
} from './app-wallet-swap-provider-reference';
import {
  APP_WALLET_SWAP_CHAIN,
  APP_WALLET_SWAP_MODE,
  AppWalletSwapOperationResponse,
  AppWalletSwapQuoteResponse,
} from './app-wallet-swap.types';

const transactionHash =
  '0xaa019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5';

function createQuote(): AppWalletSwapQuoteResponse {
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
    rawQuote: { typedData: { message: { permit2: 'synthetic' } } },
  };
}

function createOperation(): AppWalletSwapOperationResponse {
  return {
    ...createQuote(),
    operationId: '11111111-1111-4111-8111-111111111111',
    status: 'completed',
    userWalletAddress: '0x2222222222222222222222222222222222222222',
    payoutTxHash: transactionHash,
    rawTreasurySwap: { signature: 'synthetic' },
    rawPayout: { rawCircleResponse: { authorization: 'synthetic' } },
    rawRefund: { previous: { previous: {} } },
    createdAt: '2099-01-01T00:00:00.000Z',
    updatedAt: '2099-01-01T00:00:01.000Z',
    executionEnabled: true,
  };
}

describe('App Wallet swap pure helpers', () => {
  it('maps quotes and operations to the secured public response shape', () => {
    const publicQuote = toPublicAppWalletSwapQuote(createQuote());
    const publicOperation = toPublicAppWalletSwapOperation(createOperation());

    expect(publicQuote).not.toHaveProperty('rawQuote');
    expect(publicOperation).toMatchObject({
      operationId: '11111111-1111-4111-8111-111111111111',
      status: 'completed',
      amountIn: '17000000',
      payoutTxHash: transactionHash,
    });
    expect(publicOperation).not.toHaveProperty('rawQuote');
    expect(publicOperation).not.toHaveProperty('rawTreasurySwap');
    expect(publicOperation).not.toHaveProperty('rawPayout');
    expect(publicOperation).not.toHaveProperty('rawRefund');
  });

  it('removes signing material recursively from public payloads', () => {
    expect(
      removeSensitiveAppWalletSwapFields({
        safe: [{ txHash: transactionHash, typedData: 'synthetic' }],
        fundingSignature: 'synthetic',
        permit2Message: 'synthetic',
        authorizationPayload: 'synthetic',
      }),
    ).toEqual({ safe: [{ txHash: transactionHash }] });
  });

  it('sanitizes persistence payloads without removing execution references', () => {
    expect(
      sanitizeAppWalletSwapPayload({
        amount: 17_000_000n,
        apiKey: 'synthetic-api-key',
        nested: [{ status: 'COMPLETE', txHash: transactionHash }],
        quoteSignature: 'synthetic',
        rawCircleResponse: { id: 'circle-transaction-1' },
      }),
    ).toEqual({
      amount: '17000000',
      apiKey: '[REDACTED]',
      nested: [{ status: 'COMPLETE', txHash: transactionHash }],
    });
  });

  it('extracts normalized Circle transaction IDs and hashes', () => {
    const response = {
      data: {
        transaction: { id: 'circle-transaction-1', txHash: transactionHash },
      },
    };

    expect(extractCircleTransactionId(response)).toBe('circle-transaction-1');
    expect(extractCircleTransactionHash(response)).toBe(transactionHash);
    expect(extractCircleTransactionHash({ txHash: 'not-a-hash' })).toBeNull();
  });

  it('prefers current payout references and recovers deep legacy references', () => {
    const legacy = {
      transactionId: 'current-id',
      previous: {
        status: { txId: 'older-id' },
        previous: { transfer: { txId: 'deep-id', txHash: transactionHash } },
      },
    };

    expect(getPayoutTransactionId(legacy)).toBe('current-id');
    expect(getPayoutTransactionHash(legacy)).toBe(transactionHash);
  });

  it('bounds legacy traversal at 32 snapshots and terminates on cycles', () => {
    const withinBound: Record<string, unknown> = {};
    let current = withinBound;
    for (let depth = 0; depth < 31; depth += 1) {
      current.previous = {};
      current = current.previous as Record<string, unknown>;
    }
    current.transactionId = 'last-bounded-id';

    const beyondBound: Record<string, unknown> = {};
    current = beyondBound;
    for (let depth = 0; depth < 32; depth += 1) {
      current.previous = {};
      current = current.previous as Record<string, unknown>;
    }
    current.transactionId = 'out-of-bound-id';

    const cyclic: Record<string, unknown> = {};
    cyclic.previous = cyclic;

    expect(getPayoutTransactionId(withinBound)).toBe('last-bounded-id');
    expect(getPayoutTransactionId(beyondBound)).toBeNull();
    expect(getPayoutTransactionId(cyclic)).toBeNull();
  });
});
