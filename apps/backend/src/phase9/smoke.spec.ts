import { runSmoke } from './smoke';
import { fixtureRelease, fixtureMetadata } from './fixtures';

function fixtures(failPath?: string) {
  const fetch = jest.fn((url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = new Headers();
    if (
      path === '/health' &&
      object(init?.headers).Origin === 'https://app.wizpay.xyz'
    )
      headers.set('access-control-allow-origin', 'https://app.wizpay.xyz');
    const responses: Record<string, { status: number; body: unknown }> = {
      '/health': { status: 200, body: { status: 'ok' } },
      '/health/runtime-isolation': {
        status: 200,
        body: {
          network: 'arc-mainnet',
          environment: 'mainnet',
          database: {
            host: 'aws-0-ap-southeast-1.pooler.supabase.com',
            database: 'postgres',
            port: 6543,
          },
        },
      },
      '/capabilities': {
        status: 200,
        body: {
          data: {
            network: 'arc-mainnet',
            capabilities: {
              send: true,
              sameTokenPayroll: true,
              invoice: true,
              paymentLink: true,
              swap: true,
              bridge: true,
              crossTokenPayroll: true,
              liquidity: false,
              crossTokenInvoice: false,
              nanoAgentApi: false,
            },
          },
        },
      },
      '/activities':
        init?.headers && object(init.headers).Authorization
          ? { status: 200, body: { data: [] } }
          : { status: 401, body: {} },
      '/user-swap/mainnet/readiness': {
        status: 200,
        body: {
          data: { available: true, poolIdentityStatus: 'verified-live' },
        },
      },
      '/user-swap/mainnet/quote': {
        status: 201,
        body: { data: { quote: 'fixture' } },
      },
      '/bridge/quote': {
        status: 200,
        body: { data: { sourceCode: 'BASE-MAINNET' } },
      },
      '/public/invoices/p9aaaaaaaaaaaaaaaaaaaa': {
        status: 200,
        body: { data: { publicId: 'p9aaaaaaaaaaaaaaaaaaaa' } },
      },
      '/wallets/auth/challenge': {
        status: 201,
        body: { data: { challengeId: 'fixture', chainId: 5042 } },
      },
    };
    const response = responses[path];
    return Promise.resolve(
      new Response(JSON.stringify(response?.body), {
        status: path === failPath ? 500 : (response?.status ?? 404),
        headers,
      }),
    );
  });
  return fetch;
}
function object(headers: HeadersInit | undefined) {
  return (headers as Record<string, string>) ?? {};
}
describe('bounded non-financial cutover smoke', () => {
  it('checks health/CORS/database/Mainnet/quotes/checkout/auth without payment execution', async () => {
    const request = fixtures();
    const result = await runSmoke(
      {
        release: fixtureRelease(),
        metadata: fixtureMetadata(),
        checkoutId: 'p9aaaaaaaaaaaaaaaaaaaa',
        session: 'private-session-fixture',
        writeNonce: true,
      },
      request,
    );
    expect(result).toMatchObject({
      result: 'PASS',
      financialExecution: false,
      targetWritesPossible: true,
      nonceProbeAttempted: true,
    });
    expect(JSON.stringify(result)).not.toContain('private-session-fixture');
    expect(request.mock.calls.length).toBeLessThanOrEqual(12);
    for (const [url, init] of request.mock.calls) {
      expect(new URL(url).hostname).toBe('fixture.vercel.app');
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeDefined();
      expect(url).not.toMatch(
        /execute|confirm|verify|payments|recover|approval|submitted/,
      );
    }
  });
  it.each([
    '/health',
    '/health/runtime-isolation',
    '/capabilities',
    '/user-swap/mainnet/readiness',
    '/bridge/quote',
    '/wallets/auth/challenge',
  ])('failed %s blocks smoke', async (path) => {
    expect(
      (
        await runSmoke(
          {
            release: fixtureRelease(),
            metadata: fixtureMetadata(),
            writeNonce: true,
          },
          fixtures(path),
        )
      ).result,
    ).toBe('FAIL');
  });
  it('missing public fixture, session or DB probe never masquerades as complete acceptance', async () => {
    const result = await runSmoke(
      { release: fixtureRelease(), metadata: fixtureMetadata() },
      fixtures(),
    );
    expect(result.result).toBe('INCOMPLETE');
    expect(result.nonceProbeAttempted).toBe(false);
  });
  it('rejects wrong database/network before requesting anything', async () => {
    const request = fixtures();
    expect(
      (
        await runSmoke(
          {
            release: fixtureRelease(),
            metadata: { ...fixtureMetadata(), database: 'vps' },
          },
          request,
        )
      ).result,
    ).toBe('FAIL');
    expect(request).not.toHaveBeenCalled();
  });
  it('redacts thrown driver/body/network messages and never contacts a production host in fixtures', async () => {
    const secret = 'postgresql://u:password@host/postgres';
    const request = jest.fn(() => Promise.reject(new Error(secret)));
    const result = await runSmoke(
      { release: fixtureRelease(), metadata: fixtureMetadata() },
      request,
    );
    expect(result.result).toBe('FAIL');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
