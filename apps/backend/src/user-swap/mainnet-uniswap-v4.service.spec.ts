import { HttpException } from '@nestjs/common';
import { MainnetUniswapV4ReadinessService } from './mainnet-uniswap-v4-readiness.service';
import { MainnetUniswapV4Service } from './mainnet-uniswap-v4.service';
import {
  ARC_MAINNET_UNISWAP_V4_EURC,
  ARC_MAINNET_UNISWAP_V4_POOL_ID,
  ARC_MAINNET_UNISWAP_V4_USDC,
  WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS,
} from './mainnet-uniswap-v4-protocol';

const USER = '0x1234567890123456789012345678901234567890';

function request(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 5_042,
    tokenInAddress: ARC_MAINNET_UNISWAP_V4_USDC,
    tokenOutAddress: ARC_MAINNET_UNISWAP_V4_EURC,
    amountIn: '1000000',
    recipient: USER,
    walletAddress: USER,
    walletControl: 'external-wallet',
    slippageBps: 50,
    deadline: Math.floor(Date.now() / 1_000) + 300,
    quoteResult: {
      chainId: 5_042,
      quoterAddress: '0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
      poolId: ARC_MAINNET_UNISWAP_V4_POOL_ID,
      tokenInAddress: ARC_MAINNET_UNISWAP_V4_USDC,
      tokenOutAddress: ARC_MAINNET_UNISWAP_V4_EURC,
      amountIn: '1000000',
      blockNumber: 21_190_503,
      amountOut: '864736',
      gasEstimate: '37217',
    },
    ...overrides,
  };
}

const LIVE_VALIDATED = {
  zeroForOne: true,
  tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
  tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
  amountIn: 1_000_000n,
  amountOut: 864_736n,
  gasEstimate: 37_217n,
  minAmountOut: 860_412n,
  minHopPriceX36: 860_412_000_000_000_000_000_000_000_000_000_000n,
  slippageBps: 50,
  poolId: ARC_MAINNET_UNISWAP_V4_POOL_ID,
};

function service(network = 'arc-mainnet') {
  const quotes = {
    liveQuote: jest.fn().mockResolvedValue({
      observation: request().quoteResult,
      validated: LIVE_VALIDATED,
      quotedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      expiresAtBlock: 21_190_563,
    }),
    assertQuoteFresh: jest.fn().mockResolvedValue(undefined),
    assertLiveStaticQuorum: jest.fn().mockResolvedValue(undefined),
  };
  const instance = new MainnetUniswapV4Service(
    new MainnetUniswapV4ReadinessService(),
    quotes as never,
    { get: () => ({ key: network }) } as never,
  );
  return { instance, quotes };
}

describe('MainnetUniswapV4Service', () => {
  it('returns a live executable quote from the official quoter', async () => {
    const { instance, quotes } = service();
    const result = await instance.inspectQuote(request());
    expect(quotes.liveQuote).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'live',
      executable: true,
      executor: WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS,
      poolId: ARC_MAINNET_UNISWAP_V4_POOL_ID,
      poolIdentityStatus: 'verified-live',
      walletControl: 'external-wallet',
    });
    expect(result.quote?.amountOut).toBe('864736');
    expect(result.quoter.value).toBe('0');
    expect(result.expiresAtBlock).toBeGreaterThan(21_190_503);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.quoter.to).toMatch(/^0x8dc178ef/i);
  });

  it('prepares the Swap Executor plan but keeps backend submission fail-closed', async () => {
    const { instance } = service();
    const plan = await instance.prepare(request());
    expect(plan.swap.to).toBe(WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS);
    expect(plan.executable).toBe(false);
    expect(plan.permit2).toBeNull();
    expect(() => instance.execute(request())).toThrow(HttpException);
  });

  it('rejects stale pinned quotes at prepare time', async () => {
    const { instance, quotes } = service();
    quotes.assertQuoteFresh.mockRejectedValueOnce(
      new HttpException(
        { code: 'ARC_MAINNET_UNISWAP_V4_UNAVAILABLE', message: 'stale' },
        503,
      ),
    );
    await expect(instance.prepare(request())).rejects.toThrow(HttpException);
  });

  it('rejects non-Mainnet isolation and non-external wallet control', async () => {
    await expect(
      service('arc-legacy').instance.inspectQuote(request()),
    ).rejects.toThrow(HttpException);
    await expect(
      service().instance.inspectQuote(
        request({ walletControl: 'custodial-wallet' }),
      ),
    ).rejects.toThrow(HttpException);
    await expect(
      service().instance.prepare(request({ walletControl: 'managed-app-wallet' })),
    ).rejects.toThrow(HttpException);
  });

  it('reports live readiness without static candidate blockers', async () => {
    const { instance } = service();
    await expect(instance.liveReadiness()).resolves.toMatchObject({
      available: true,
      executable: true,
      poolIdentityStatus: 'verified-live',
      blockers: [],
    });
  });
});
