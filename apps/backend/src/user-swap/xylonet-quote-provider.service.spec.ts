import type { PublicClient } from 'viem';
import { XylonetQuoteProviderService } from './xylonet-quote-provider.service';

const walletAddress = '0x90ab859240b941eaf0cbcbf42df5086e0ad54147';
const routerAddress = '0x73742278c31a76dBb0D2587d03ef92E6E2141023';
const executorAddress = '0x1111111111111111111111111111111111111111';

const baseRequest = {
  amountIn: '1000000000',
  chain: 'ARC-TESTNET' as const,
  fromAddress: walletAddress,
  toAddress: walletAddress,
  tokenIn: 'USDC' as const,
  tokenOut: 'EURC' as const,
  slippageBps: 200,
};

describe('XylonetQuoteProviderService', () => {
  const originalEnv = process.env;
  const readContract = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    process.env = { ...originalEnv };
    process.env.WIZPAY_XYLONET_ROUTER_ADDRESS = routerAddress;
    process.env.WIZPAY_SWAP_EXECUTOR_ADDRESS = executorAddress;
    process.env.WIZPAY_SWAP_EXECUTOR_FEE_BPS = '25';
    readContract.mockResolvedValue(977_550_000n);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function createService() {
    return new XylonetQuoteProviderService({
      readContract,
    } as unknown as PublicClient);
  }

  it('quotes XyloNet with netAmountIn after executor fee', async () => {
    const result = await createService().quote(baseRequest);

    expect(readContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: routerAddress,
        functionName: 'getAmountOut',
        args: [
          '0x3600000000000000000000000000000000000000',
          '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a',
          997_500_000n,
        ],
      }),
    );
    expect(result).toMatchObject({
      provider: 'xylonet',
      routerAddress,
      executorAddress,
      amountIn: '1000000000',
      feeAmount: '2500000',
      netAmountIn: '997500000',
      expectedAmountOut: '977550000',
      expectedOutput: '977550000',
      minimumAmountOut: '957999000',
      minAmountOut: '957999000',
      chainId: 5042002,
    });
    expect(result.raw).toMatchObject({
      feeAmount: '2500000',
      netAmountIn: '997500000',
      expectedAmountOut: '977550000',
      minAmountOut: '957999000',
    });
  });

  it('fails closed when executor address is missing', async () => {
    delete process.env.WIZPAY_SWAP_EXECUTOR_ADDRESS;

    await expect(createService().quote(baseRequest)).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_XYLONET_CONFIG_MISSING',
      },
    });
    expect(readContract).not.toHaveBeenCalled();
  });

  it('fails closed when router address is missing', async () => {
    delete process.env.WIZPAY_XYLONET_ROUTER_ADDRESS;

    await expect(createService().quote(baseRequest)).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_XYLONET_CONFIG_MISSING',
      },
    });
    expect(readContract).not.toHaveBeenCalled();
  });

  it('rejects unsupported token pairs', async () => {
    await expect(
      createService().quote({ ...baseRequest, tokenIn: 'USDC', tokenOut: 'USDC' }),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_XYLONET_UNSUPPORTED_PAIR',
      },
    });
    expect(readContract).not.toHaveBeenCalled();
  });

  it('rejects wrong chains before quote execution', async () => {
    await expect(
      createService().quote({ ...baseRequest, chain: 'BASE' as 'ARC-TESTNET' }),
    ).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_UNSUPPORTED_CHAIN',
      },
    });
    expect(readContract).not.toHaveBeenCalled();
  });

  it('rejects executor fee config above cap', async () => {
    process.env.WIZPAY_SWAP_EXECUTOR_FEE_BPS = '101';

    await expect(createService().quote(baseRequest)).rejects.toMatchObject({
      response: {
        code: 'USER_SWAP_XYLONET_FEE_CONFIG_INVALID',
      },
    });
    expect(readContract).not.toHaveBeenCalled();
  });
});
