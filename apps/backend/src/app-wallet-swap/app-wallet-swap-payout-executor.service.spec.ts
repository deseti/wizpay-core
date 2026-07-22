import { MODULE_METADATA } from '@nestjs/common/constants';
import { AppWalletSwapCircleExecutorService } from './app-wallet-swap-circle-executor.service';
import { AppWalletSwapModule } from './app-wallet-swap.module';
import { AppWalletSwapPayoutExecutorService } from './app-wallet-swap-payout-executor.service';
import { APP_WALLET_SWAP_CHAIN } from './app-wallet-swap.types';

const TREASURY_ADDRESS = '0x1111111111111111111111111111111111111111';
const USER_ADDRESS = '0x2222222222222222222222222222222222222222';
const EURC_ADDRESS = '0x3333333333333333333333333333333333333333';
const USDC_ADDRESS = '0x4444444444444444444444444444444444444444';
const PAYOUT_HASH =
  '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_HASH =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('AppWalletSwapPayoutExecutorService', () => {
  const circleExecutor = {
    formatBaseUnits: jest.fn(),
    getTransactionStatus: jest.fn(),
    listW3sTransactions: jest.fn(),
    submitTransfer: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<
      AppWalletSwapCircleExecutorService,
      | 'formatBaseUnits'
      | 'getTransactionStatus'
      | 'listW3sTransactions'
      | 'submitTransfer'
    >
  >;
  let executor: AppWalletSwapPayoutExecutorService;

  const submissionInput = Object.freeze({
    walletId: 'wallet-1',
    network: APP_WALLET_SWAP_CHAIN,
    token: 'EURC' as const,
    recipientAddress: USER_ADDRESS,
    payoutAmount: '1234567',
    tokenDecimals: 6,
    idempotencyKey: 'operation-1:payout',
  });

  const recoveryInput = Object.freeze({
    treasuryWalletId: 'wallet-1',
    tokenAddresses: Object.freeze({
      EURC: EURC_ADDRESS,
      USDC: USDC_ADDRESS,
    }),
    payout: Object.freeze({
      tokenOut: 'EURC' as const,
      payoutAmount: '1234567',
      treasuryDepositAddress: TREASURY_ADDRESS,
      userWalletAddress: USER_ADDRESS,
      payoutSubmittedAt: '2026-07-22T00:00:00.000Z',
    }),
  });

  beforeEach(() => {
    jest.resetAllMocks();
    circleExecutor.formatBaseUnits.mockReturnValue('1.234567');
    executor = new AppWalletSwapPayoutExecutorService(
      circleExecutor as unknown as AppWalletSwapCircleExecutorService,
    );
  });

  it('is registered in the App Wallet swap module', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      AppWalletSwapModule,
    );

    expect(providers).toContain(AppWalletSwapPayoutExecutorService);
  });

  it('submits one payout with the exact provider fields and deterministic idempotency key', async () => {
    circleExecutor.submitTransfer.mockResolvedValue({
      txId: 'transaction-1',
      status: 'SENT',
      txHash: PAYOUT_HASH,
    });

    await expect(executor.submitPayout(submissionInput)).resolves.toMatchObject(
      {
        transactionId: 'transaction-1',
        txHash: PAYOUT_HASH,
        providerStatus: 'SENT',
      },
    );
    expect(circleExecutor.formatBaseUnits).toHaveBeenCalledWith('1234567', 6);
    expect(circleExecutor.submitTransfer).toHaveBeenCalledTimes(1);
    expect(circleExecutor.submitTransfer).toHaveBeenCalledWith({
      walletId: 'wallet-1',
      network: APP_WALLET_SWAP_CHAIN,
      token: 'EURC',
      toAddress: USER_ADDRESS,
      amount: '1.234567',
      idempotencyKey: 'operation-1:payout',
    });
    expect(submissionInput).toEqual({
      walletId: 'wallet-1',
      network: APP_WALLET_SWAP_CHAIN,
      token: 'EURC',
      recipientAddress: USER_ADDRESS,
      payoutAmount: '1234567',
      tokenDecimals: 6,
      idempotencyKey: 'operation-1:payout',
    });
  });

  it('returns a flat sanitized submission snapshot without sensitive provider data', async () => {
    circleExecutor.submitTransfer.mockResolvedValue({
      txId: 'transaction-1',
      status: 'QUEUED',
      txHash: null,
    });

    const result = await executor.submitPayout(submissionInput);

    expect(result).toEqual({
      transactionId: 'transaction-1',
      txHash: null,
      providerStatus: 'QUEUED',
      snapshot: {
        provider: 'circle',
        transactionId: 'transaction-1',
        txHash: null,
        providerStatus: 'QUEUED',
        transfer: {
          txId: 'transaction-1',
          status: 'QUEUED',
          txHash: null,
        },
        observedAt: expect.any(String),
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /authorization|signature|typedData|apiKey|entitySecret|previous/i,
    );
  });

  it('rejects an unaccepted optional submission hash exactly as before', async () => {
    circleExecutor.submitTransfer.mockResolvedValue({
      txId: 'transaction-1',
      status: 'SENT',
      txHash: 'not-a-transaction-hash',
    });

    await expect(executor.submitPayout(submissionInput)).resolves.toMatchObject(
      {
        transactionId: 'transaction-1',
        txHash: null,
      },
    );
  });

  it('propagates payout submission errors unchanged', async () => {
    const providerError = new Error('synthetic provider failure');
    circleExecutor.submitTransfer.mockRejectedValue(providerError);

    await expect(executor.submitPayout(submissionInput)).rejects.toBe(
      providerError,
    );
  });

  it('recovers stored payout references through bounded legacy snapshots', () => {
    expect(
      executor.getStoredPayoutReferences({
        previous: {
          transfer: { txId: 'legacy-transaction-1', txHash: PAYOUT_HASH },
        },
      }),
    ).toEqual({
      transactionId: 'legacy-transaction-1',
      txHash: PAYOUT_HASH,
    });
  });

  it.each([
    ['QUEUED', false],
    ['SENT', false],
    ['CONFIRMED', false],
    ['COMPLETE', false],
    ['FAILED', true],
    ['CANCELLED', true],
    ['DENIED', true],
  ] as const)(
    'normalizes known transaction status %s with failed=%s',
    async (status, failed) => {
      circleExecutor.getTransactionStatus.mockResolvedValue({
        txId: 'transaction-1',
        status,
        txHash: status === 'COMPLETE' ? PAYOUT_HASH : null,
        blockNumber: status === 'COMPLETE' ? '10' : null,
        errorReason: failed ? 'synthetic failure' : null,
      });

      const result = await executor.getPayoutStatus('transaction-1');

      expect(circleExecutor.getTransactionStatus).toHaveBeenCalledTimes(1);
      expect(circleExecutor.getTransactionStatus).toHaveBeenCalledWith(
        'transaction-1',
      );
      expect(result).toMatchObject({
        transactionId: 'transaction-1',
        providerStatus: status,
        failed,
        txHash: status === 'COMPLETE' ? PAYOUT_HASH : null,
        errorReason: failed ? 'synthetic failure' : null,
      });
    },
  );

  it('ignores an unrelated malformed hash from known transaction status', async () => {
    circleExecutor.getTransactionStatus.mockResolvedValue({
      txId: 'transaction-1',
      status: 'COMPLETE',
      txHash: 'transaction-1',
      blockNumber: '10',
      errorReason: null,
    });

    await expect(
      executor.getPayoutStatus('transaction-1'),
    ).resolves.toMatchObject({ txHash: null });
  });

  it('returns only a sanitized known-status snapshot', async () => {
    circleExecutor.getTransactionStatus.mockResolvedValue({
      txId: 'transaction-1',
      status: 'COMPLETE',
      txHash: PAYOUT_HASH,
      blockNumber: '10',
      errorReason: null,
    });

    const result = await executor.getPayoutStatus('transaction-1');

    expect(result.snapshot).toEqual({
      provider: 'circle',
      transactionId: 'transaction-1',
      txHash: PAYOUT_HASH,
      providerStatus: 'COMPLETE',
      status: {
        txId: 'transaction-1',
        status: 'COMPLETE',
        txHash: PAYOUT_HASH,
        blockNumber: '10',
        errorReason: null,
      },
      observedAt: expect.any(String),
    });
  });

  it('propagates known transaction lookup errors unchanged', async () => {
    const providerError = new Error('synthetic lookup failure');
    circleExecutor.getTransactionStatus.mockRejectedValue(providerError);

    await expect(executor.getPayoutStatus('transaction-1')).rejects.toBe(
      providerError,
    );
  });

  it('lists once and reuses the Phase 2B payout matcher for exact recovery', async () => {
    const matchingTransaction = {
      id: 'transaction-1',
      blockchain: APP_WALLET_SWAP_CHAIN,
      walletId: 'wallet-1',
      sourceAddress: TREASURY_ADDRESS,
      destinationAddress: USER_ADDRESS,
      tokenSymbol: 'EURC',
      state: 'COMPLETE',
      operation: 'TRANSFER',
      transactionType: 'OUTBOUND',
      amount: '1.234567',
      createDate: '2026-07-22T00:00:01.000Z',
      txHash: PAYOUT_HASH,
      refId: 'unrelated-and-not-used-by-the-existing-payout-matcher',
    };
    circleExecutor.listW3sTransactions.mockResolvedValue({
      transactions: [
        { ...matchingTransaction, destinationAddress: TREASURY_ADDRESS },
        matchingTransaction,
      ],
    });

    await expect(
      executor.recoverPayoutReference(recoveryInput),
    ).resolves.toEqual({
      transactionId: 'transaction-1',
      txHash: PAYOUT_HASH,
      providerStatus: 'COMPLETE',
      snapshot: {
        provider: 'circle',
        transactionId: 'transaction-1',
        txHash: PAYOUT_HASH,
        providerStatus: 'COMPLETE',
        resolvedTransaction: matchingTransaction,
        observedAt: expect.any(String),
      },
    });
    expect(circleExecutor.listW3sTransactions).toHaveBeenCalledTimes(1);
    expect(circleExecutor.listW3sTransactions).toHaveBeenCalledWith({
      walletIds: 'wallet-1',
    });
  });

  it.each([
    ['source wallet', { treasuryWalletId: 'wallet-2' }],
    [
      'recipient',
      {
        payout: {
          ...recoveryInput.payout,
          userWalletAddress: TREASURY_ADDRESS,
        },
      },
    ],
    [
      'token',
      { payout: { ...recoveryInput.payout, tokenOut: 'USDC' as const } },
    ],
    [
      'amount',
      { payout: { ...recoveryInput.payout, payoutAmount: '1234568' } },
    ],
    [
      'time window',
      {
        payout: {
          ...recoveryInput.payout,
          payoutSubmittedAt: '2026-07-22T00:01:00.000Z',
        },
      },
    ],
  ])(
    'returns no recovery match when %s does not match',
    async (_, override) => {
      circleExecutor.listW3sTransactions.mockResolvedValue({
        transactions: [
          {
            id: 'transaction-1',
            blockchain: APP_WALLET_SWAP_CHAIN,
            walletId: 'wallet-1',
            sourceAddress: TREASURY_ADDRESS,
            destinationAddress: USER_ADDRESS,
            tokenSymbol: 'EURC',
            state: 'COMPLETE',
            operation: 'TRANSFER',
            transactionType: 'OUTBOUND',
            amount: '1.234567',
            createDate: '2026-07-22T00:00:01.000Z',
            txHash: PAYOUT_HASH,
          },
        ],
      });

      await expect(
        executor.recoverPayoutReference({
          ...recoveryInput,
          ...override,
        }),
      ).resolves.toBeNull();
    },
  );

  it('accepts the same nested final hash location during list recovery', async () => {
    circleExecutor.listW3sTransactions.mockResolvedValue({
      transactions: [
        {
          id: 'transaction-1',
          blockchain: APP_WALLET_SWAP_CHAIN,
          walletId: 'wallet-1',
          sourceAddress: TREASURY_ADDRESS,
          destinationAddress: USER_ADDRESS,
          tokenSymbol: 'EURC',
          state: 'COMPLETE',
          operation: 'TRANSFER',
          transactionType: 'OUTBOUND',
          amount: '1.234567',
          createDate: '2026-07-22T00:00:01.000Z',
          transaction: { transactionHash: OTHER_HASH },
        },
      ],
    });

    await expect(
      executor.recoverPayoutReference(recoveryInput),
    ).resolves.toMatchObject({
      transactionId: 'transaction-1',
      txHash: OTHER_HASH,
    });
  });

  it('preserves the stored transaction ID when a matched list record omits its ID', async () => {
    circleExecutor.listW3sTransactions.mockResolvedValue({
      transactions: [
        {
          blockchain: APP_WALLET_SWAP_CHAIN,
          walletId: 'wallet-1',
          sourceAddress: TREASURY_ADDRESS,
          destinationAddress: USER_ADDRESS,
          tokenSymbol: 'EURC',
          state: 'COMPLETE',
          operation: 'TRANSFER',
          transactionType: 'OUTBOUND',
          amount: '1.234567',
          createDate: '2026-07-22T00:00:01.000Z',
          txHash: PAYOUT_HASH,
        },
      ],
    });

    const result = await executor.recoverPayoutReference({
      ...recoveryInput,
      existingTransactionId: 'stored-transaction-1',
    });

    expect(result).toMatchObject({
      transactionId: 'stored-transaction-1',
      txHash: PAYOUT_HASH,
      providerStatus: 'COMPLETE',
    });
  });

  it('returns no match for malformed provider collections', async () => {
    circleExecutor.listW3sTransactions.mockResolvedValue({ malformed: true });

    await expect(
      executor.recoverPayoutReference(recoveryInput),
    ).resolves.toBeNull();
  });

  it('propagates recovery-list errors unchanged', async () => {
    const providerError = new Error('synthetic list failure');
    circleExecutor.listW3sTransactions.mockRejectedValue(providerError);

    await expect(executor.recoverPayoutReference(recoveryInput)).rejects.toBe(
      providerError,
    );
  });
});
