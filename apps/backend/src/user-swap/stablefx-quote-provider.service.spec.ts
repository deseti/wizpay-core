import { StablefxQuoteProviderService } from './stablefx-quote-provider.service';
import {
  USER_SWAP_API_BASE_URL,
  USER_SWAP_STABLEFX_QUOTE_API_BASE_URL,
  USER_SWAP_STABLEFX_QUOTE_URL,
} from './user-swap.types';

const baseRequest = {
  amountIn: '2000000', // 2 USDC in 6-decimal base units
  fromAddress: '0x90ab859240b941eaf0cbcbf42df5086e0ad54147',
  toAddress: '0x90ab859240b941eaf0cbcbf42df5086e0ad54147',
  chain: 'ARC-TESTNET' as const,
};

describe('StablefxQuoteProviderService', () => {
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

  function jsonResponse(body: unknown, init: ResponseInit = {}) {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 201,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  }

  function getFetchBody(): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls.at(-1) ?? [];
    const body = (init as RequestInit | undefined)?.body;

    return JSON.parse(String(body)) as Record<string, unknown>;
  }

  function getFetchHeaders(): Record<string, string> {
    const [, init] = fetchMock.mock.calls.at(-1) ?? [];

    return (init as RequestInit | undefined)?.headers as Record<string, string>;
  }

  it('maps a USDC -> EURC reference quote correctly', async () => {
    process.env.CIRCLE_STABLEFX_API_KEY = 'stablefx-secret';
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: 'quote-usdc-eurc',
          rate: '1.1183',
          from: { amount: '2', currency: 'USDC' },
          to: { amount: '1.788428', currency: 'EURC' },
          fee: '0',
          collateral: '0',
          createdAt: '2026-05-30T12:00:00Z',
        },
      }),
    );
    const service = new StablefxQuoteProviderService();

    const result = await service.quote({
      ...baseRequest,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api-sandbox.circle.com/v1/exchange/stablefx/quotes',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(USER_SWAP_STABLEFX_QUOTE_API_BASE_URL).toBe(
      'https://api-sandbox.circle.com',
    );
    expect(USER_SWAP_STABLEFX_QUOTE_URL).toBe(
      'https://api-sandbox.circle.com/v1/exchange/stablefx/quotes',
    );
    expect(USER_SWAP_API_BASE_URL).toBe('https://api.circle.com');
    // Base units -> decimal amount for the upstream request.
    expect(getFetchBody()).toEqual({
      type: 'reference',
      tenor: 'instant',
      from: { currency: 'USDC', amount: '2' },
      to: { currency: 'EURC' },
    });
    expect(result).toMatchObject({
      provider: 'stablefx',
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      amountIn: '2000000',
      quoteId: 'quote-usdc-eurc',
      // 1.788428 EURC -> 6-decimal base units.
      expectedOutput: '1788428',
    });
  });

  it('maps an EURC -> USDC reference quote correctly', async () => {
    process.env.CIRCLE_STABLEFX_API_KEY = 'stablefx-secret';
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: 'quote-eurc-usdc',
          rate: '0.8942',
          from: { amount: '2', currency: 'EURC' },
          to: { amount: '2.234567', currency: 'USDC' },
          fee: '0',
          collateral: '0',
          createdAt: '2026-05-30T12:00:00Z',
        },
      }),
    );
    const service = new StablefxQuoteProviderService();

    const result = await service.quote({
      ...baseRequest,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
    });

    expect(getFetchBody()).toEqual({
      type: 'reference',
      tenor: 'instant',
      from: { currency: 'EURC', amount: '2' },
      to: { currency: 'USDC' },
    });
    expect(result).toMatchObject({
      provider: 'stablefx',
      tokenIn: 'EURC',
      tokenOut: 'USDC',
      quoteId: 'quote-eurc-usdc',
      expectedOutput: '2234567',
    });
  });

  it('converts 6-decimal base units to a decimal amount string', () => {
    const service = new StablefxQuoteProviderService();

    expect(service.baseUnitsToDecimalString('2000000', 6)).toBe('2');
    expect(service.baseUnitsToDecimalString('1788428', 6)).toBe('1.788428');
    expect(service.baseUnitsToDecimalString('1500000', 6)).toBe('1.5');
    expect(service.baseUnitsToDecimalString('1', 6)).toBe('0.000001');
  });

  it('converts a decimal output back to 6-decimal base units', () => {
    const service = new StablefxQuoteProviderService();

    expect(service.decimalToBaseUnits('1.788428', 6)).toBe('1788428');
    expect(service.decimalToBaseUnits('2', 6)).toBe('2000000');
    expect(service.decimalToBaseUnits('0.5', 6)).toBe('500000');
    // Excess precision is truncated, never rounded up.
    expect(service.decimalToBaseUnits('1.1234567', 6)).toBe('1123456');
  });

  it('derives a minimum output from slippage when provided', async () => {
    process.env.CIRCLE_STABLEFX_API_KEY = 'stablefx-secret';
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: 'quote-slippage',
          rate: '1.0',
          from: { amount: '2', currency: 'USDC' },
          to: { amount: '2', currency: 'EURC' },
        },
      }),
    );
    const service = new StablefxQuoteProviderService();

    const result = await service.quote({
      ...baseRequest,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      slippageBps: 200,
    });

    // 2000000 * (10000 - 200) / 10000 = 1960000
    expect(result.expectedOutput).toBe('2000000');
    expect(result.minimumOutput).toBe('1960000');
  });

  it('fails clearly when CIRCLE_STABLEFX_API_KEY is missing', async () => {
    delete process.env.CIRCLE_STABLEFX_API_KEY;
    const service = new StablefxQuoteProviderService();

    await expect(
      service.quote({ ...baseRequest, tokenIn: 'USDC', tokenOut: 'EURC' }),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_STABLEFX_API_KEY_MISSING',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a clear minimum-amount error for StableFX code 3005', async () => {
    process.env.CIRCLE_STABLEFX_API_KEY = 'stablefx-secret';
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { code: 3005, message: 'Amount is below the minimum' },
        { status: 400 },
      ),
    );
    const service = new StablefxQuoteProviderService();

    await expect(
      service.quote({ ...baseRequest, tokenIn: 'USDC', tokenOut: 'EURC' }),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_STABLEFX_AMOUNT_BELOW_MINIMUM',
        details: { code: 3005 },
      },
    });
  });

  it('surfaces auth/entitlement failures as a blocker, not a gateway error', async () => {
    process.env.CIRCLE_STABLEFX_API_KEY = 'stablefx-secret';
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 401, message: 'unauthorized' }, { status: 401 }),
    );
    const service = new StablefxQuoteProviderService();

    await expect(
      service.quote({ ...baseRequest, tokenIn: 'USDC', tokenOut: 'EURC' }),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_STABLEFX_AUTH_BLOCKED',
      },
    });
  });

  it('rejects unsupported pairs without calling the API', async () => {
    process.env.CIRCLE_STABLEFX_API_KEY = 'stablefx-secret';
    const service = new StablefxQuoteProviderService();

    await expect(
      // USDC -> USDC is not a supported cross-currency pair.
      service.quote({
        ...baseRequest,
        tokenIn: 'USDC',
        tokenOut: 'USDC' as 'EURC',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_STABLEFX_UNSUPPORTED_PAIR',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never exposes the API key in the response', async () => {
    process.env.CIRCLE_STABLEFX_API_KEY = 'stablefx-secret';
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: 'quote-1',
          rate: '1.1',
          from: { amount: '2', currency: 'USDC' },
          to: { amount: '2.2', currency: 'EURC' },
        },
      }),
    );
    const service = new StablefxQuoteProviderService();

    const result = await service.quote({
      ...baseRequest,
      tokenIn: 'USDC',
      tokenOut: 'EURC',
    });

    expect(getFetchHeaders().Authorization).toBe('Bearer stablefx-secret');
    expect(JSON.stringify(result)).not.toContain('stablefx-secret');
  });
});
