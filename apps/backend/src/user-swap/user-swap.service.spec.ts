import { UserSwapService } from './user-swap.service';

const wallet = '0x90ab859240b941eaf0cbcbf42df5086e0ad54147';
const baseRequest = {
  tokenIn: 'USDC',
  tokenOut: 'EURC',
  amountIn: '1000000',
  fromAddress: wallet,
  toAddress: wallet,
  chain: 'ARC-MAINNET',
  slippageBps: 200,
};

describe('UserSwapService (Mainnet Uniswap V4 only)', () => {
  const mainnetSwap = {
    inspectQuote: jest.fn(() => ({ status: 'executor-prepared' })),
  };
  const service = new UserSwapService(
    mainnetSwap as never,
    { assert: jest.fn() } as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it.each([
    ['USDC', 'EURC'],
    ['EURC', 'USDC'],
  ])('routes %s to %s to Mainnet Uniswap V4 only', async (tokenIn, tokenOut) => {
    const result = await service.quote({ ...baseRequest, tokenIn, tokenOut });
    expect(result.provider).toBe('uniswap-v4');
    expect(result.chain).toBe('ARC-MAINNET');
    expect(mainnetSwap.inspectQuote).toHaveBeenCalledTimes(1);
    expect(mainnetSwap.inspectQuote).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 5_042,
        walletControl: 'external-wallet',
      }),
    );
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
    expect(mainnetSwap.inspectQuote).not.toHaveBeenCalled();
  });

  it('rejects chain and token mismatches before calling the provider', async () => {
    await expect(
      service.quote({ ...baseRequest, chain: 'BASE' }),
    ).rejects.toBeDefined();
    await expect(
      service.quote({ ...baseRequest, tokenOut: 'USDC' }),
    ).rejects.toBeDefined();
    expect(mainnetSwap.inspectQuote).not.toHaveBeenCalled();
  });

  it('rejects non-canonical amounts before calling the provider', async () => {
    await expect(
      service.quote({ ...baseRequest, amountIn: '1.5' }),
    ).rejects.toMatchObject({
      response: { code: 'USER_SWAP_INVALID_REQUEST' },
    });
    expect(mainnetSwap.inspectQuote).not.toHaveBeenCalled();
  });
});
