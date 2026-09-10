/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { ConfigService } from '@nestjs/config';
import { encodeFunctionData } from 'viem';
import { W3sAuthService } from './w3s-auth.service';

describe('W3sAuthService User-Controlled transaction lookup', () => {
  const originalFetch = global.fetch;
  let service: W3sAuthService;
  let intents: Record<string, jest.Mock>;
  const sourceWallet = '0x9999999999999999999999999999999999999999';

  beforeEach(() => {
    const values: Record<string, unknown> = {
      'arcNetwork.key': 'arc-testnet',
      'arcNetwork.tokens.USDC.address':
        '0x3600000000000000000000000000000000000000',
      'arcNetwork.tokens.EURC.address':
        '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
      CIRCLE_TESTNET_API_KEY: 'TEST_API_KEY',
      CIRCLE_TESTNET_APP_ID: 'testnet-app-id',
      CIRCLE_TESTNET_API_BASE_URL: 'https://api.circle.test',
      CIRCLE_TESTNET_RECEIPT_CONFIRMATIONS: '2',
    };
    const config = {
      get: jest.fn((key: string) => values[key]),
      getOrThrow: jest.fn((key: string) => {
        if (values[key] === undefined) throw new Error(`Missing ${key}`);
        return values[key];
      }),
    } as unknown as ConfigService;
    const prisma = {
      userWallet: {
        findUnique: jest.fn().mockResolvedValue({
          address: sourceWallet,
          blockchain: 'ARC-TESTNET',
          userId: 'circle-user-1',
          walletSetId: null,
        }),
      },
    };
    intents = {
      get: jest.fn(async (id: string) => {
        const control = id === 'intent-control';
        return {
          id,
          network: 'arc-testnet',
          operation: 'SEND',
          ownerId: null,
          walletId: null,
          sourceWallet,
          recipient: control
            ? '0x2222222222222222222222222222222222222222'
            : '0x1111111111111111111111111111111111111111',
          tokenIn: '0x3600000000000000000000000000000000000000',
          tokenOut: '0x3600000000000000000000000000000000000000',
          amountUnits: '1000000',
          externalReference: control
            ? 'SEND-control'
            : 'SEND-established-account',
          idempotencyKey: control
            ? '22222222-2222-4222-8222-222222222222'
            : '11111111-1111-4111-8111-111111111111',
          route: 'DIRECT_TRANSFER',
          status: 'CREATED',
          circleChallengeId: null,
        };
      }),
      bindImmutableExecutionContext: jest.fn(),
      acquireLease: jest.fn(),
      transition: jest.fn(async (id: string) => ({
        ...(await intents.get(id)),
        status: 'AUTHORIZATION_PENDING',
      })),
      bindCircleCorrelation: jest.fn(),
    };
    service = new W3sAuthService(
      config,
      prisma as never,
      { assertW3sAction: jest.fn() } as never,
      intents as never,
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('gets the Circle transaction by ID and maps data.transaction.txHash', async () => {
    const txHash = `0x${'e'.repeat(64)}`;
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            transaction: {
              id: 'circle-transaction-id',
              state: 'COMPLETE',
              txHash,
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      service.getUserTransaction(
        'circle-transaction-id',
        'sanitized-user-token',
      ),
    ).resolves.toEqual({
      transaction: {
        id: 'circle-transaction-id',
        state: 'COMPLETE',
        txHash,
      },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.circle.test/v1/w3s/transactions/circle-transaction-id',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'X-User-Token': 'sanitized-user-token',
        }),
      }),
    );
  });

  it('resolves a completed challenge correlation without treating its challenge ID as a transaction ID', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            challenge: {
              id: 'challenge-id',
              status: 'COMPLETE',
              correlationIds: ['transaction-id'],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    await expect(
      service.dispatch('getUserChallenge', {
        challengeId: 'challenge-id',
        userToken: 'sanitized-user-token',
      }),
    ).resolves.toEqual({
      challenge: {
        id: 'challenge-id',
        status: 'COMPLETE',
        correlationIds: ['transaction-id'],
      },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.circle.test/v1/w3s/user/challenges/challenge-id',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          'X-User-Token': 'sanitized-user-token',
        }),
      }),
    );
  });

  it('lists user-scoped wallet transactions for read-only recovery', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { transactions: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(
      service.dispatch('listUserTransactions', {
        walletId: 'wallet-id',
        userToken: 'sanitized-user-token',
      }),
    ).resolves.toEqual({ transactions: [] });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.circle.test/v1/w3s/transactions?pageSize=50&order=ASC&walletIds=wallet-id',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('passes documented pagination filters for complete recovery', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { transactions: [] } }), {
        status: 200,
      }),
    );
    await service.dispatch('listUserTransactions', {
      walletId: 'wallet-id',
      userToken: 'sanitized-user-token',
      pageAfter: 'cursor-id',
      from: '2026-08-29T00:00:00Z',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('pageAfter=cursor-id'),
      expect.objectContaining({ method: 'GET' }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('from=2026-08-29T00%3A00%3A00Z'),
      expect.anything(),
    );
  });

  it('refreshes the Circle session through the documented endpoint without logging credentials', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            userToken: 'rotated-user',
            encryptionKey: 'rotated-key',
            refreshToken: 'rotated-refresh',
          },
        }),
        { status: 200 },
      ),
    );
    await expect(
      service.dispatch('refreshUserToken', {
        userToken: 'old-user',
        refreshToken: 'old-refresh',
        deviceId: 'device-id',
      }),
    ).resolves.toMatchObject({
      userToken: 'rotated-user',
      encryptionKey: 'rotated-key',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.circle.test/v1/w3s/users/token/refresh',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-User-Token': 'old-user' }),
      }),
    );
  });

  it('surfaces definitive refresh rejection for reauthentication', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ code: 155719, message: 'expired' }), {
        status: 401,
      }),
    );
    await expect(
      service.dispatch('refreshUserToken', {
        userToken: 'old-user',
        refreshToken: 'old-refresh',
        deviceId: 'device-id',
      }),
    ).rejects.toMatchObject({ status: 401, code: 155719 });
  });

  it('proxies the documented user-scoped transfer fee estimate', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { medium: { gasLimit: '100000', maxFee: '0.02' } },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );
    await expect(
      service.dispatch('estimateTransferFee', {
        amounts: ['1'],
        destinationAddress: '0x1111111111111111111111111111111111111111',
        tokenAddress: '0x3600000000000000000000000000000000000000',
        tokenId: 'token-usdc',
        walletId: 'wallet-id',
        userToken: 'sanitized-user-token',
        wizpayChain: 'ARC-TESTNET',
      }),
    ).resolves.toEqual({ medium: { gasLimit: '100000', maxFee: '0.02' } });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.circle.test/v1/w3s/transactions/transfer/estimateFee',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-User-Token': 'sanitized-user-token',
        }),
      }),
    );
  });

  it('rejects a full-balance Arc USDC transfer before creating a challenge', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { medium: { gasLimit: '100000', maxFee: '0.02' } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              tokenBalances: [
                {
                  amount: '5.9891',
                  token: {
                    id: 'token-usdc',
                    symbol: 'USDC',
                    isNative: true,
                  },
                },
              ],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    await expect(
      service.dispatch('createTransferChallenge', {
        amounts: ['5.989093'],
        destinationAddress: '0x1111111111111111111111111111111111111111',
        tokenAddress: '0x3600000000000000000000000000000000000000',
        feeLevel: 'MEDIUM',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        executionIntentId: 'intent-established',
        refId: 'SEND-1',
        tokenId: 'token-usdc',
        walletId: 'wallet-id',
        userToken: 'sanitized-user-token',
        wizpayChain: 'ARC-TESTNET',
      }),
    ).rejects.toMatchObject({
      code: 'W3S_INSUFFICIENT_ARC_GAS',
      status: 422,
      details: {
        challengeCreationAttempted: false,
        lifecycleStage: 'preflight_validation',
      },
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('creates the transfer for an established Arc account with native gas dust and another USDC row', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { medium: { gasLimit: '100000', maxFee: '0.02' } },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              tokenBalances: [
                {
                  amount: '0',
                  token: {
                    id: 'old-usdc-token',
                    blockchain: 'ARC-TESTNET',
                    decimals: 6,
                    isNative: false,
                    symbol: 'USDC',
                  },
                },
                {
                  amount: '5.989093812345678901',
                  token: {
                    id: 'arc-native-usdc-token',
                    blockchain: 'ARC-TESTNET',
                    decimals: 18,
                    isNative: true,
                    symbol: 'USDC',
                  },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { challengeId: 'challenge-id' } }),
          { status: 200 },
        ),
      );

    await expect(
      service.dispatch('createTransferChallenge', {
        amounts: ['1'],
        destinationAddress: '0x1111111111111111111111111111111111111111',
        tokenAddress: '0x3600000000000000000000000000000000000000',
        executionIntentId: 'intent-established',
        feeLevel: 'MEDIUM',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        refId: 'SEND-established-account',
        tokenId: 'arc-native-usdc-token',
        walletId: 'arc-wallet-id',
        userToken: 'current-account-user-token',
        wizpayChain: 'ARC-TESTNET',
      }),
    ).resolves.toEqual({ challengeId: 'challenge-id' });

    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      'https://api.circle.test/v1/w3s/user/transactions/transfer',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"walletId":"arc-wallet-id"'),
        headers: expect.objectContaining({
          'X-User-Token': 'current-account-user-token',
        }),
      }),
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      expect.objectContaining({
        body: expect.stringContaining('"tokenId":"arc-native-usdc-token"'),
      }),
    );
  });

  it('keeps the ordinary successful-account transfer path unchanged', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { medium: {} } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              tokenBalances: [
                {
                  amount: '10',
                  token: {
                    id: 'token-usdc',
                    isNative: true,
                    symbol: 'USDC',
                  },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { challengeId: 'control' } }), {
          status: 200,
        }),
      );
    await expect(
      service.dispatch('createTransferChallenge', {
        amounts: ['1'],
        destinationAddress: '0x2222222222222222222222222222222222222222',
        tokenAddress: '0x3600000000000000000000000000000000000000',
        executionIntentId: 'intent-control',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        tokenId: 'token-usdc',
        walletId: 'control-wallet',
        userToken: 'control-user-token',
        wizpayChain: 'ARC-TESTNET',
      }),
    ).resolves.toEqual({ challengeId: 'control' });
  });

  it('fails closed before Circle transaction creation when executionIntentId is missing', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { medium: {} } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              tokenBalances: [
                {
                  amount: '10',
                  token: { id: 'token-usdc', isNative: true, symbol: 'USDC' },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );
    await expect(
      service.dispatch('createTransferChallenge', {
        amounts: ['1'],
        destinationAddress: '0x2222222222222222222222222222222222222222',
        tokenAddress: '0x3600000000000000000000000000000000000000',
        tokenId: 'token-usdc',
        walletId: 'control-wallet',
        userToken: 'control-user-token',
        wizpayChain: 'ARC-TESTNET',
      }),
    ).rejects.toMatchObject({
      response: { code: 'EXECUTION_INTENT_REQUIRED' },
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('fails closed for an ERC20 approval challenge without executionIntentId', async () => {
    global.fetch = jest.fn();
    const callData = encodeFunctionData({
      abi: [
        {
          type: 'function',
          name: 'approve',
          stateMutability: 'nonpayable',
          inputs: [
            { name: 'spender', type: 'address' },
            { name: 'amount', type: 'uint256' },
          ],
          outputs: [{ name: '', type: 'bool' }],
        },
      ] as const,
      functionName: 'approve',
      args: ['0x1111111111111111111111111111111111111111', 1n],
    });

    await expect(
      service.dispatch('createContractExecutionChallenge', {
        callData,
        contractAddress: '0x3600000000000000000000000000000000000000',
        idempotencyKey: '33333333-3333-4333-8333-333333333333',
        refId: 'PAYROLL-APPROVAL',
        userToken: 'control-user-token',
        walletId: 'control-wallet',
      }),
    ).rejects.toMatchObject({
      response: { code: 'EXECUTION_INTENT_REQUIRED' },
    });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects an immutable intent mismatch before Circle transaction creation', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { medium: {} } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              tokenBalances: [
                {
                  amount: '10',
                  token: { id: 'token-usdc', isNative: true, symbol: 'USDC' },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      );
    await expect(
      service.dispatch('createTransferChallenge', {
        amounts: ['2'],
        destinationAddress: '0x2222222222222222222222222222222222222222',
        tokenAddress: '0x3600000000000000000000000000000000000000',
        executionIntentId: 'intent-control',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        tokenId: 'token-usdc',
        walletId: 'control-wallet',
        userToken: 'control-user-token',
        wizpayChain: 'ARC-TESTNET',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(intents.acquireLease).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
