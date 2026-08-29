/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { ConfigService } from '@nestjs/config';
import { W3sAuthService } from './w3s-auth.service';

describe('W3sAuthService User-Controlled transaction lookup', () => {
  const originalFetch = global.fetch;
  let service: W3sAuthService;

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'CIRCLE_API_KEY') return 'TEST_API_KEY';
        if (key === 'CIRCLE_BASE_URL') return 'https://api.circle.test';
        return undefined;
      }),
    } as unknown as ConfigService;
    service = new W3sAuthService(config, {} as never);
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
        feeLevel: 'MEDIUM',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
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
        tokenId: 'token-usdc',
        walletId: 'control-wallet',
        userToken: 'control-user-token',
        wizpayChain: 'ARC-TESTNET',
      }),
    ).resolves.toEqual({ challengeId: 'control' });
  });
});
