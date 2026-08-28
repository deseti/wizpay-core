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
      'https://api.circle.test/v1/w3s/transactions?pageSize=50&walletIds=wallet-id',
      expect.objectContaining({ method: 'GET' }),
    );
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
                  token: { id: 'token-usdc', symbol: 'USDC' },
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
    ).rejects.toThrow('Leave enough USDC');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });
});
