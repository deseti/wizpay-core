import { smokeVercelApi, validationOrigin } from './vercel-smoke';

describe('independent Vercel API smoke checks', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  it('rejects production/VPS origins, credentials and redirect-shaped URLs', () => {
    for (const value of [
      'https://app.wizpay.xyz',
      'http://demo.vercel.app',
      'https://demo.vercel.app/?token=secret',
      'https://user:secret@demo.vercel.app',
      'https://demo.vercel.app/path',
    ])
      expect(() => validationOrigin(value)).toThrow();
    expect(validationOrigin('https://wizpay-api-serverless.vercel.app')).toBe(
      'https://wizpay-api-serverless.vercel.app',
    );
  });
  it('does not treat readiness HTTP 200 with unavailable RPC as success or leak responses', async () => {
    const values = [
      { status: 'ok' },
      {
        network: 'arc-mainnet',
        environment: 'mainnet',
        database: {
          host: 'example.pooler.supabase.com',
          port: 6543,
          database: 'postgres',
        },
      },
      {
        data: {
          network: 'arc-mainnet',
          capabilities: { swap: false, bridge: false },
        },
      },
      { data: { challengeId: 'test', chainId: 5042 } },
      {
        data: {
          available: false,
          blockers: ['sensitive provider diagnostics'],
        },
      },
    ];
    const fetchMock = jest.fn((_url: string, init?: RequestInit) => {
      const body = values.shift();
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: init?.method === 'POST' ? 201 : 200,
          headers: { 'Access-Control-Allow-Origin': 'https://app.wizpay.xyz' },
        }),
      );
    });
    global.fetch = fetchMock as typeof fetch;
    await expect(smokeVercelApi('https://demo.vercel.app')).rejects.toThrow(
      'Vercel API smoke failed at Arc RPC and Uniswap read quorum.',
    );
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain(
      'https://app.wizpay.xyz',
    );
    expect(
      fetchMock.mock.calls.every(
        ([url]) => !/execute|approve|verify|submitted/.test(url),
      ),
    ).toBe(true);
  });
});
