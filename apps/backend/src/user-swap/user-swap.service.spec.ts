import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  USER_SWAP_EURC_ADDRESS,
  USER_SWAP_STABLECOIN_KITS_CHAIN,
  USER_SWAP_USDC_ADDRESS,
  UserSwapService,
} from './user-swap.service';

const baseRequest = {
  tokenIn: 'USDC',
  tokenOut: 'EURC',
  amountIn: '10',
  fromAddress: '0x90ab859240b941eaf0cbcbf42df5086e0ad54147',
  chain: 'ARC-TESTNET',
};

describe('UserSwapService', () => {
  const originalEnv = process.env;
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    global.fetch = fetchMock;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function enableUserSwap() {
    process.env.WIZPAY_USER_SWAP_ENABLED = 'true';
    process.env.WIZPAY_USER_SWAP_ALLOW_TESTNET = 'true';
    process.env.WIZPAY_USER_SWAP_KIT_KEY = 'kit-secret';
  }

  function jsonResponse(body: unknown, init: ResponseInit = {}) {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  }

  function getFetchUrl(): URL {
    const [url] = fetchMock.mock.calls.at(-1) ?? [];

    return new URL(String(url));
  }

  function getFetchBody(): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls.at(-1) ?? [];
    const body = (init as RequestInit | undefined)?.body;

    return JSON.parse(String(body)) as Record<string, unknown>;
  }

  it('is disabled by default', async () => {
    const service = new UserSwapService();

    await expect(service.quote(baseRequest)).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_DISABLED',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires the testnet allow flag', async () => {
    process.env.WIZPAY_USER_SWAP_ENABLED = 'true';
    process.env.WIZPAY_USER_SWAP_KIT_KEY = 'kit-secret';
    const service = new UserSwapService();

    await expect(service.quote(baseRequest)).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_TESTNET_DISABLED',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requires a server-side kit key', async () => {
    process.env.WIZPAY_USER_SWAP_ENABLED = 'true';
    process.env.WIZPAY_USER_SWAP_ALLOW_TESTNET = 'true';
    const service = new UserSwapService();

    await expect(service.quote(baseRequest)).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_KIT_KEY_MISSING',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects unsupported chains', async () => {
    process.env.WIZPAY_USER_SWAP_ENABLED = 'true';
    const service = new UserSwapService();

    await expect(
      service.quote({ ...baseRequest, chain: 'BASE' }),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_UNSUPPORTED_CHAIN',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('calls Circle quote API with Authorization header and API-compatible query params', async () => {
    enableUserSwap();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        quoteId: 'quote-1',
        estimatedOutput: { token: 'EURC', amount: '9.8' },
        minOutput: { token: 'EURC', amount: '9.7' },
      }),
    );
    const service = new UserSwapService();

    const result = await service.quote(baseRequest);
    const quoteUrl = getFetchUrl();

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining(
        'https://api.circle.com/v1/stablecoinKits/quote?',
      ),
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer kit-secret',
        }),
      }),
    );
    expect(quoteUrl.pathname).toBe('/v1/stablecoinKits/quote');
    expect(quoteUrl.searchParams.get('tokenInAddress')).toBe(
      USER_SWAP_USDC_ADDRESS,
    );
    expect(quoteUrl.searchParams.get('tokenInChain')).toBe(
      USER_SWAP_STABLECOIN_KITS_CHAIN,
    );
    expect(quoteUrl.searchParams.get('tokenOutAddress')).toBe(
      USER_SWAP_EURC_ADDRESS,
    );
    expect(quoteUrl.searchParams.get('tokenOutChain')).toBe(
      USER_SWAP_STABLECOIN_KITS_CHAIN,
    );
    expect(quoteUrl.searchParams.get('fromAddress')).toBe(
      baseRequest.fromAddress,
    );
    expect(quoteUrl.searchParams.get('toAddress')).toBe(baseRequest.fromAddress);
    expect(quoteUrl.searchParams.get('amount')).toBe('10');
    expect(quoteUrl.searchParams.has('slippageBps')).toBe(false);
    expect(result).toMatchObject({
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      amountIn: '10',
      fromAddress: baseRequest.fromAddress,
      toAddress: baseRequest.fromAddress,
      chain: 'ARC-TESTNET',
      quoteId: 'quote-1',
    });
  });

  it('includes optional quote slippageBps when provided', async () => {
    enableUserSwap();
    fetchMock.mockResolvedValueOnce(jsonResponse({ quoteId: 'quote-1' }));
    const service = new UserSwapService();

    await service.quote({ ...baseRequest, slippageBps: 150 });

    expect(getFetchUrl().searchParams.get('slippageBps')).toBe('150');
  });

  it('calls Circle swap API with API-compatible body for prepare but does not sign', async () => {
    enableUserSwap();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        transaction: {
          to: '0x0000000000000000000000000000000000000001',
          data: '0x1234',
          value: '0',
        },
      }),
    );
    const service = new UserSwapService();

    const result = await service.prepare({
      ...baseRequest,
      slippageBps: 300,
    });
    const prepareBody = getFetchBody();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.circle.com/v1/stablecoinKits/swap',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer kit-secret',
        }),
      }),
    );
    expect(prepareBody).toMatchObject({
      tokenInAddress: USER_SWAP_USDC_ADDRESS,
      tokenInChain: USER_SWAP_STABLECOIN_KITS_CHAIN,
      tokenOutAddress: USER_SWAP_EURC_ADDRESS,
      tokenOutChain: USER_SWAP_STABLECOIN_KITS_CHAIN,
      fromAddress: baseRequest.fromAddress,
      toAddress: baseRequest.fromAddress,
      amount: '10',
      slippageBps: 300,
    });
    expect(prepareBody).not.toHaveProperty('tokenIn');
    expect(prepareBody).not.toHaveProperty('tokenOut');
    expect(prepareBody).not.toHaveProperty('amountIn');
    expect(prepareBody).not.toHaveProperty('chain');
    expect(result.transaction).toMatchObject({
      to: '0x0000000000000000000000000000000000000001',
      data: '0x1234',
      value: '0',
    });
    expect(result).not.toHaveProperty('signature');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('calls Circle status API', async () => {
    enableUserSwap();
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'CONFIRMED' }));
    const service = new UserSwapService();

    const txHash =
      '0xdd019e059ddbbbd32f73c444e350838553779dc027926111366ace5195faa1d5';
    const result = await service.status({ txHash, chain: 'ARC-TESTNET' });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.circle.com/v1/stablecoinKits/swap/status?chain=${USER_SWAP_STABLECOIN_KITS_CHAIN}&txHash=${txHash}`,
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer kit-secret',
        }),
      }),
    );
    expect(result).toMatchObject({
      txHash,
      chain: 'ARC-TESTNET',
      status: 'CONFIRMED',
    });
  });

  it('does not expose the kit key in successful responses', async () => {
    enableUserSwap();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        quoteId: 'quote-1',
        estimatedOutput: { token: 'EURC', amount: '9.8' },
      }),
    );
    const service = new UserSwapService();

    const result = await service.quote(baseRequest);

    expect(JSON.stringify(result)).not.toContain('kit-secret');
  });

  it('maps Circle API failures to CIRCLE_STABLECOIN_API_FAILED', async () => {
    enableUserSwap();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: 'denied' }, { status: 403 }),
    );
    const service = new UserSwapService();

    await expect(service.quote(baseRequest)).rejects.toMatchObject({
      response: {
        code: 'CIRCLE_STABLECOIN_API_FAILED',
      },
    });
  });

  it('maps missing prepare transaction to unexpected response', async () => {
    enableUserSwap();
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const service = new UserSwapService();

    await expect(service.prepare(baseRequest)).rejects.toMatchObject({
      response: {
        code: 'CIRCLE_STABLECOIN_UNEXPECTED_RESPONSE',
      },
    });
  });

  it('keeps user-swap isolated from treasury executors and legacy swap routes', () => {
    const userSwapDir = __dirname;
    const files = collectTsFiles(userSwapDir).filter(
      (file) => !file.endsWith('.spec.ts'),
    );
    const forbidden = new RegExp(
      [
        'official-swap',
        'OfficialSwap',
        'CircleAgentWalletSwapExecutor',
        'StableFXAdapter',
        'StableFXRfqClient',
        'tasks/swap/init',
        'child_process',
        'spawn\\(',
        'exec\\(',
        'privateKey',
      ].join('|'),
    );

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(forbidden);
    }
  });
});

function collectTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      return collectTsFiles(fullPath);
    }

    return entry.isFile() && fullPath.endsWith('.ts') ? [fullPath] : [];
  });
}
