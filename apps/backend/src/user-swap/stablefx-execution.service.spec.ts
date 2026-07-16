import { StablefxExecutionService } from './stablefx-execution.service';
import {
  USER_SWAP_API_BASE_URL,
  USER_SWAP_STABLEFX_FUND_PATH,
  USER_SWAP_STABLEFX_FUNDING_PRESIGN_PATH,
  USER_SWAP_STABLEFX_QUOTE_PATH,
  USER_SWAP_STABLEFX_TRADES_PATH,
} from './user-swap.types';

const STABLEFX_EXECUTION_API_BASE_URL = 'https://api-sandbox.circle.com';

const walletAddress = '0x90ab859240b941eaf0cbcbf42df5086e0ad54147';
const baseQuoteRequest = {
  amountIn: '2000000',
  chain: 'ARC-TESTNET',
  fromAddress: walletAddress,
  recipientAddress: walletAddress,
  tokenIn: 'USDC',
  tokenOut: 'EURC',
};

const typedData = {
  domain: {
    name: 'Permit2',
    chainId: 5042002,
    verifyingContract: '0x0000000000000000000000000000000000000001',
  },
  types: {
    EIP712Domain: [{ name: 'name', type: 'string' }],
    PermitWitnessTransferFrom: [
      { name: 'permitted', type: 'TokenPermissions' },
    ],
    TokenPermissions: [{ name: 'token', type: 'address' }],
  },
  primaryType: 'PermitWitnessTransferFrom',
  message: {
    permitted: {
      token: '0x3600000000000000000000000000000000000000',
      amount: '2000000',
    },
    spender: '0x0000000000000000000000000000000000000002',
    nonce: '1',
    deadline: 1770302983,
    witness: { id: '24' },
  },
};

describe('StablefxExecutionService', () => {
  const originalEnv = process.env;
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    process.env.WIZPAY_USER_SWAP_ENABLED = 'true';
    process.env.WIZPAY_USER_SWAP_ALLOW_TESTNET = 'true';
    process.env.WIZPAY_SWAP_PROVIDER = 'stablefx';
    process.env.CIRCLE_STABLEFX_API_KEY = 'stablefx-secret';
    global.fetch = fetchMock;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function jsonResponse(body: unknown, init: ResponseInit = {}) {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    });
  }

  function getFetchBody(): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls.at(-1) ?? [];
    const body = (init as RequestInit | undefined)?.body;

    return JSON.parse(String(body)) as Record<string, unknown>;
  }

  it('requests a tradable StableFX quote with recipientAddress and typedData', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'quote-1',
        from: { currency: 'USDC', amount: '2' },
        to: { currency: 'EURC', amount: '1.8' },
        typedData,
      }),
    );
    const service = new StablefxExecutionService();

    const result = await service.createTradableQuote(baseQuoteRequest);

    expect(fetchMock).toHaveBeenCalledWith(
      `${STABLEFX_EXECUTION_API_BASE_URL}${USER_SWAP_STABLEFX_QUOTE_PATH}`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer stablefx-secret',
        }),
      }),
    );
    expect(USER_SWAP_API_BASE_URL).toBe('https://api.circle.com');
    expect(getFetchBody()).toEqual({
      from: { currency: 'USDC', amount: '2.00' },
      to: { currency: 'EURC' },
      tenor: 'instant',
      type: 'tradable',
      recipientAddress: walletAddress,
    });
    expect(result).toMatchObject({ id: 'quote-1', typedData });
  });

  it('creates a trade with a required idempotency key', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: '11111111-1111-4111-8111-111111111111',
        contractTradeId: '24',
        status: 'pending',
      }),
    );
    const service = new StablefxExecutionService();

    const result = await service.createTrade({
      address: walletAddress,
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      message: typedData.message,
      quoteId: 'quote-1',
      signature: '0xabc123',
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      walletMode: 'external',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${STABLEFX_EXECUTION_API_BASE_URL}${USER_SWAP_STABLEFX_TRADES_PATH}`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(getFetchBody()).toMatchObject({
      address: walletAddress,
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      message: typedData.message,
      quoteId: 'quote-1',
      signature: '0xabc123',
    });
    expect(result).toMatchObject({ contractTradeId: '24' });
  });

  it('normalizes nested create trade responses before returning to the client', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          trade: {
            id: '11111111-1111-4111-8111-111111111111',
            contractTradeId: '24',
            status: 'pending',
          },
        },
      }),
    );
    const service = new StablefxExecutionService();

    const result = await service.createTrade({
      address: walletAddress,
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      message: typedData.message,
      quoteId: 'quote-1',
      signature: '0xabc123',
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      walletMode: 'external',
    });

    expect(result).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      contractTradeId: '24',
      status: 'pending',
    });
  });

  it('returns a pending created trade when the contract trade id is not ready yet', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: '11111111-1111-4111-8111-111111111111',
          quoteId: '33333333-3333-4333-8333-333333333333',
          status: 'pending',
        },
      }),
    );
    const service = new StablefxExecutionService();

    const result = await service.createTrade({
      address: walletAddress,
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      message: typedData.message,
      quoteId: 'quote-1',
      signature: '0xabc123',
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      walletMode: 'external',
    });

    expect(result).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      quoteId: '33333333-3333-4333-8333-333333333333',
      status: 'pending',
    });
    expect(result.contractTradeId).toBeUndefined();
  });

  it('fails locally before create trade when signer-like message address conflicts', async () => {
    const service = new StablefxExecutionService();

    await expect(
      service.createTrade({
        address: walletAddress,
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        message: {
          ...typedData.message,
          taker: '0x1111111111111111111111111111111111111111',
        },
        quoteId: 'quote-1',
        signature: '0xabc123',
        tokenIn: 'USDC',
        tokenOut: 'EURC',
        walletMode: 'external',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_STABLEFX_ADDRESS_MISMATCH',
        message:
          'StableFX typed-data address fields do not match the create trade address.',
        details: {
          path: 'message.taker',
        },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails locally before create trade when selected address differs from create address', async () => {
    const service = new StablefxExecutionService();

    await expect(
      service.createTrade({
        address: walletAddress,
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        message: typedData.message,
        quoteId: 'quote-1',
        selectedAddress: '0x1111111111111111111111111111111111111111',
        signature: '0xabc123',
        tokenIn: 'USDC',
        tokenOut: 'EURC',
        walletMode: 'external',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_STABLEFX_ADDRESS_MISMATCH',
        message:
          'StableFX create trade address does not match the selected wallet address.',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not reject token or spender address fields before create trade', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: '11111111-1111-4111-8111-111111111111',
        contractTradeId: '24',
        status: 'pending',
      }),
    );
    const service = new StablefxExecutionService();

    await service.createTrade({
      address: walletAddress,
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      message: typedData.message,
      quoteId: 'quote-1',
      signature: '0xabc123',
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      walletMode: 'external',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requests taker funding presign data for the contract trade id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ typedData }));
    const service = new StablefxExecutionService();

    const result = await service.createFundingPresign({
      contractTradeId: '24',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${STABLEFX_EXECUTION_API_BASE_URL}${USER_SWAP_STABLEFX_FUNDING_PRESIGN_PATH}`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(getFetchBody()).toEqual({
      contractTradeIds: ['24'],
      type: 'taker',
    });
    expect(result).toMatchObject({ typedData });
  });

  it('funds the taker side with the signed Permit2 payload', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 200 }));
    const service = new StablefxExecutionService();

    const result = await service.fund({
      permit2: typedData.message,
      signature: '0xdef456',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${STABLEFX_EXECUTION_API_BASE_URL}${USER_SWAP_STABLEFX_FUND_PATH}`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(getFetchBody()).toEqual({
      type: 'taker',
      permit2: typedData.message,
      signature: '0xdef456',
    });
    expect(result).toEqual({});
  });

  it('gets a StableFX trade by ID for polling', async () => {
    const tradeId = '11111111-1111-4111-8111-111111111111';
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: tradeId,
        contractTradeId: '24',
        status: 'taker_funded',
      }),
    );
    const service = new StablefxExecutionService();

    const result = await service.getTrade(tradeId);

    expect(fetchMock).toHaveBeenCalledWith(
      `${STABLEFX_EXECUTION_API_BASE_URL}${USER_SWAP_STABLEFX_TRADES_PATH}/${tradeId}`,
      expect.objectContaining({ method: 'GET' }),
    );
    expect(result).toMatchObject({ status: 'taker_funded' });
  });

  it('fails closed when WIZPAY_SWAP_PROVIDER is not stablefx', async () => {
    process.env.WIZPAY_SWAP_PROVIDER = 'swapkit';
    const service = new StablefxExecutionService();

    await expect(
      service.createTradableQuote(baseQuoteRequest),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_STABLEFX_EXECUTION_DISABLED',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when CIRCLE_STABLEFX_API_KEY is missing', async () => {
    delete process.env.CIRCLE_STABLEFX_API_KEY;
    const service = new StablefxExecutionService();

    await expect(
      service.createTradableQuote(baseQuoteRequest),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_STABLEFX_API_KEY_MISSING',
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces auth and entitlement failures as StableFX blockers', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 403, message: 'forbidden' }, { status: 403 }),
    );
    const service = new StablefxExecutionService();

    await expect(
      service.createTradableQuote(baseQuoteRequest),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_STABLEFX_AUTH_BLOCKED',
        details: { code: 403, message: 'forbidden' },
      },
    });
  });

  it('surfaces StableFX code 3004 as a typed quote-expired error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 3004, message: 'Quote expired' }, { status: 400 }),
    );
    const service = new StablefxExecutionService();

    await expect(
      service.createTrade({
        address: walletAddress,
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        message: typedData.message,
        quoteId: 'quote-1',
        signature: '0xabc123',
        tokenIn: 'USDC',
        tokenOut: 'EURC',
        walletMode: 'external',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_STABLEFX_QUOTE_EXPIRED',
        message:
          'StableFX quote expired before signing completed. Please retry.',
        details: {
          code: 3004,
          message: 'Quote expired',
        },
      },
    });
  });

  it('surfaces StableFX code 3005 as an executable amount error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { code: 3005, message: 'The quote amount is invalid.' },
        { status: 400 },
      ),
    );
    const service = new StablefxExecutionService();

    await expect(
      service.createTradableQuote(baseQuoteRequest),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_STABLEFX_AMOUNT_BELOW_MINIMUM',
        details: {
          code: 3005,
          message: 'The quote amount is invalid.',
        },
      },
    });
  });

  it('surfaces StableFX code 3015 as a typed address mismatch error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          code: 3015,
          message:
            'The provided signature could not be verified against the expected address.',
        },
        { status: 400 },
      ),
    );
    const service = new StablefxExecutionService();

    await expect(
      service.createTrade({
        address: walletAddress,
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
        message: typedData.message,
        quoteId: 'quote-1',
        signature: '0xabc123',
        tokenIn: 'USDC',
        tokenOut: 'EURC',
        walletMode: 'external',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_STABLEFX_ADDRESS_MISMATCH',
        message:
          'StableFX could not verify the signature against the create trade address.',
        details: {
          code: 3015,
          message:
            'The provided signature could not be verified against the expected address.',
        },
      },
    });
  });

  it('does not expose the StableFX API key in successful responses', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 'quote-1',
        typedData,
      }),
    );
    const service = new StablefxExecutionService();

    const result = await service.createTradableQuote(baseQuoteRequest);

    expect(JSON.stringify(result)).not.toContain('stablefx-secret');
  });

  it('allows External Wallet EURC->USDC execution to reach StableFX create trade', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: '11111111-1111-4111-8111-111111111111',
          status: 'pending',
        },
      }),
    );
    const service = new StablefxExecutionService();

    const result = await service.createTrade({
      address: walletAddress,
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      message: typedData.message,
      quoteId: 'quote-1',
      signature: '0xabc123',
      tokenIn: 'EURC',
      tokenOut: 'USDC',
      walletMode: 'external',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${STABLEFX_EXECUTION_API_BASE_URL}${USER_SWAP_STABLEFX_TRADES_PATH}`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(getFetchBody()).toMatchObject({
      address: walletAddress,
      quoteId: 'quote-1',
    });
    expect(result).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'pending',
    });
  });

  it('allows App Wallet StableFX execution to reach StableFX create trade', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: {
          id: '11111111-1111-4111-8111-111111111111',
          status: 'pending',
        },
      }),
    );
    const service = new StablefxExecutionService();

    const result = await service.createTrade({
      address: walletAddress,
      idempotencyKey: '22222222-2222-4222-8222-222222222222',
      message: typedData.message,
      quoteId: 'quote-1',
      signature: '0xabc123',
      tokenIn: 'USDC',
      tokenOut: 'EURC',
      walletMode: 'circle',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `${STABLEFX_EXECUTION_API_BASE_URL}${USER_SWAP_STABLEFX_TRADES_PATH}`,
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result).toMatchObject({
      id: '11111111-1111-4111-8111-111111111111',
      status: 'pending',
    });
  });
});
