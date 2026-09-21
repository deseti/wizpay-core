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

function service(network = 'arc-mainnet') {
  return new MainnetUniswapV4Service(new MainnetUniswapV4ReadinessService(), {
    get: () => ({ key: network }),
  } as never);
}

describe('MainnetUniswapV4Service', () => {
  it('returns an executor-prepared quote plan without enabling execution', () => {
    const result = service().inspectQuote(request());
    expect(result).toMatchObject({
      status: 'executor-prepared',
      executable: false,
      executor: WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS,
      poolId: ARC_MAINNET_UNISWAP_V4_POOL_ID,
      poolIdentityStatus: 'candidate-unverified',
      walletControl: 'external-wallet',
    });
    expect(result.quote?.amountOut).toBe('864736');
    expect(result.quoter.value).toBe('0');
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.quoter.to).toMatch(/^0x8dc178ef/i);
  });

  it('prepares the Swap Executor plan but keeps backend submission fail-closed', () => {
    const instance = service();
    const plan = instance.prepare(request());
    expect(plan.swap.to).toBe(WIZPAY_SWAP_EXECUTOR_MAINNET_ADDRESS);
    expect(plan.executable).toBe(false);
    expect(plan.permit2).toBeNull();
    expect(() => instance.execute(request())).toThrow(HttpException);
  });

  it('rejects non-Mainnet isolation and non-external wallet control', () => {
    expect(() => service('arc-legacy').inspectQuote(request())).toThrow(
      HttpException,
    );
    expect(() =>
      service().inspectQuote(
        request({ walletControl: 'custodial-wallet' }),
      ),
    ).toThrow(HttpException);
    expect(() =>
      service().prepare(request({ walletControl: 'managed-app-wallet' })),
    ).toThrow(HttpException);
  });

  it('does not treat verified pool identity as execution authorization', () => {
    const result = service().inspectQuote(request());
    expect(result.poolIdentityStatus).toBe('candidate-unverified');
    expect(result.blockers).toEqual(
      expect.arrayContaining([
        'ARC_MAINNET_UNISWAP_EXECUTION_AUTHORIZATION_UNAVAILABLE',
      ]),
    );
    expect(result.executable).toBe(false);
  });
});
