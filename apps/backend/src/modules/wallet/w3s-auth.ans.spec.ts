import { ConfigService } from '@nestjs/config';
import { W3sAuthService } from './w3s-auth.service';

describe('W3sAuthService ANS contract execution', () => {
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

  it.each([
    ['approval', '0x3600000000000000000000000000000000000000'],
    ['registration', '0x201ffb769476976df29bdbe95064cab59c6e12c3'],
  ])('submits the ANS %s challenge with the caller idempotency key', async (_, contractAddress) => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ data: { challengeId: 'ans-challenge-id' } }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      service.dispatch('createContractExecutionChallenge', {
        callData: '0x1234',
        contractAddress,
        idempotencyKey: '6fc2fd98-e45b-4eb5-b09d-1a32de4d14ee',
        refId: 'ANS-REGISTER-test.arc',
        userToken: 'sanitized-user-token',
        walletId: 'wallet-id',
      }),
    ).resolves.toEqual({ challengeId: 'ans-challenge-id' });

    const request = (global.fetch as jest.Mock).mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.idempotencyKey).toBe('6fc2fd98-e45b-4eb5-b09d-1a32de4d14ee');
    expect(body.userToken).toBeUndefined();
  });

  it('propagates the sanitized Circle status, code, endpoint, and message', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 155903,
          message: 'Contract execution rejected by policy.',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await expect(
      service.dispatch('createContractExecutionChallenge', {
        callData: '0x1234',
        contractAddress: '0x201ffb769476976df29bdbe95064cab59c6e12c3',
        refId: 'ANS-REGISTER-test.arc',
        userToken: 'sanitized-user-token',
        walletId: 'wallet-id',
      }),
    ).rejects.toMatchObject({
      code: 155903,
      details: {
        circleMessage: 'Contract execution rejected by policy.',
        circleStatus: 400,
        method: 'POST',
        path: '/v1/w3s/user/transactions/contractExecution',
      },
      message: 'Contract execution rejected by policy.',
      status: 400,
    });
  });
});
