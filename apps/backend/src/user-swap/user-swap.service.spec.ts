import { UserSwapService } from './user-swap.service';

const wallet = '0x90ab859240b941eaf0cbcbf42df5086e0ad54147';
const baseRequest = {
  tokenIn: 'USDC',
  tokenOut: 'EURC',
  amountIn: '1000000',
  fromAddress: wallet,
  toAddress: wallet,
  chain: 'ARC-TESTNET',
  slippageBps: 200,
};

describe('UserSwapService', () => {
  const xylonet = {
    quote: jest.fn(async (request) => ({
      ...request,
      provider: 'xylonet',
      raw: {},
    })),
  };
  const service = new UserSwapService(xylonet as never);

  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['USDC', 'EURC'],
    ['EURC', 'USDC'],
  ])('routes %s to %s to XyloNet only', async (tokenIn, tokenOut) => {
    const result = await service.quote({ ...baseRequest, tokenIn, tokenOut });
    expect(result.provider).toBe('xylonet');
    expect(xylonet.quote).toHaveBeenCalledTimes(1);
  });

  it('rejects recipient mismatch before calling the provider', async () => {
    await expect(
      service.quote({
        ...baseRequest,
        toAddress: '0x1111111111111111111111111111111111111111',
      }),
    ).rejects.toMatchObject({
      response: { code: 'USER_SWAP_INVALID_REQUEST' },
    });
    expect(xylonet.quote).not.toHaveBeenCalled();
  });

  it('rejects chain and token mismatches before calling the provider', async () => {
    await expect(
      service.quote({ ...baseRequest, chain: 'BASE' }),
    ).rejects.toBeDefined();
    await expect(
      service.quote({ ...baseRequest, tokenOut: 'USDC' }),
    ).rejects.toBeDefined();
    expect(xylonet.quote).not.toHaveBeenCalled();
  });
});
