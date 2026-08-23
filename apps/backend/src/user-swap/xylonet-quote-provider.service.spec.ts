import type { PublicClient } from 'viem';
import { XylonetQuoteProviderService } from './xylonet-quote-provider.service';

const wallet = '0x90ab859240b941eaf0cbcbf42df5086e0ad54147';
const router = '0x73742278c31a76dBb0D2587d03ef92E6E2141023';
const executor = '0x7B5573759576AD3AD9F9E3b4425ad68FD2b525ed';
const safe = '0xAA557eb00063ad487BFe0304Bd04B4d45114b721';
const usdc = '0x3600000000000000000000000000000000000000';
const eurc = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const request = {
  amountIn: '1000000000',
  chain: 'ARC-TESTNET' as const,
  fromAddress: wallet,
  toAddress: wallet,
  tokenIn: 'USDC' as const,
  tokenOut: 'EURC' as const,
  slippageBps: 200,
};

describe('XylonetQuoteProviderService', () => {
  const originalEnv = process.env;
  const readContract = jest.fn(async (input: { functionName: string }) => {
    if (input.functionName === 'getAmountOut') return 977_550_000n;
    if (input.functionName === 'owner' || input.functionName === 'feeRecipient')
      return safe;
    if (input.functionName === 'feeBps') return 25n;
    if (
      input.functionName === 'allowedRouters' ||
      input.functionName === 'allowedTokens'
    )
      return true;
    throw new Error(`Unexpected read ${input.functionName}`);
  });
  const getBytecode = jest.fn(async () => '0x6000');

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.APP_XYLONET_ROUTER_ADDRESSES = router;
    process.env.WIZPAY_SWAP_EXECUTOR_V2_ADDRESS = executor;
    process.env.APP_XYLONET_TOKEN_ADDRESSES = `USDC=${usdc},EURC=${eurc}`;
    process.env.WIZPAY_FEE_SAFE = safe;
  });
  afterAll(() => {
    process.env = originalEnv;
  });

  function service() {
    return new XylonetQuoteProviderService({
      readContract,
      getBytecode,
    } as unknown as PublicClient);
  }

  it.each([
    ['USDC', 'EURC'],
    ['EURC', 'USDC'],
  ] as const)(
    'quotes %s to %s through canonical V2',
    async (tokenIn, tokenOut) => {
      const result = await service().quote({ ...request, tokenIn, tokenOut });
      expect(result).toMatchObject({
        provider: 'xylonet',
        executorAddress: executor,
        routerAddress: router,
        recipientAddress: wallet,
        amountIn: '1000000000',
        feeAmount: '2500000',
        minimumAmountOut: '957999000',
        chainId: 5042002,
      });
      expect(Date.parse(result.expiresAt as string)).toBeGreaterThan(
        Date.now(),
      );
    },
  );

  it('fails closed when the canonical executor is absent or unsafe', async () => {
    delete process.env.WIZPAY_SWAP_EXECUTOR_V2_ADDRESS;
    await expect(service().quote(request)).rejects.toMatchObject({
      response: { code: 'USER_SWAP_XYLONET_CONFIG_MISSING' },
    });
    process.env.WIZPAY_SWAP_EXECUTOR_V2_ADDRESS = executor;
    getBytecode.mockResolvedValueOnce('0x');
    await expect(service().quote(request)).rejects.toMatchObject({
      response: { code: 'USER_SWAP_XYLONET_CONFIG_MISSING' },
    });
  });

  it('propagates provider failure without invoking another provider', async () => {
    readContract.mockImplementationOnce(
      async (input: { functionName: string }) => {
        if (input.functionName === 'getAmountOut')
          throw new Error('provider unavailable');
        return 0n;
      },
    );
    await expect(service().quote(request)).rejects.toBeDefined();
  });
});
