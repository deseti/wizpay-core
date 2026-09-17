import { HttpException } from '@nestjs/common';
import {
  ARC_MAINNET_UNISWAP_V4_ERROR_CODES,
  MainnetUniswapV4ReadinessService,
} from './mainnet-uniswap-v4-readiness.service';

const NOW = 2_000_000_000;
const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
const USER = '0x1234567890123456789012345678901234567890';

function request(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 5_042,
    tokenInAddress: USDC,
    tokenOutAddress: EURC,
    amountIn: '1000000',
    recipient: USER,
    walletAddress: USER,
    walletControl: 'external-wallet',
    slippageBps: 50,
    deadline: NOW + 300,
    ...overrides,
  };
}

describe('MainnetUniswapV4ReadinessService', () => {
  const service = new MainnetUniswapV4ReadinessService();

  it('accepts only the external-wallet boundary without enabling execution', () => {
    const normalized = service.validateBoundary(request(), NOW);
    expect(normalized).toMatchObject({
      chainId: 5_042,
      amountIn: 1_000_000n,
      walletControl: 'external-wallet',
      slippageBps: 50,
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(service.readiness.executable).toBe(false);
    expect(service.readiness.capabilityEnabled).toBe(false);
  });

  it('accepts only the reverse official pair as the other direction', () => {
    expect(
      service.validateBoundary(
        request({ tokenInAddress: EURC, tokenOutAddress: USDC }),
        NOW,
      ),
    ).toMatchObject({ tokenInAddress: EURC, tokenOutAddress: USDC });
  });

  it('accepts the maximum uint128 amount', () => {
    const maximum = (1n << 128n) - 1n;
    expect(
      service.validateBoundary(request({ amountIn: maximum.toString() }), NOW),
    ).toMatchObject({ amountIn: maximum });
  });

  it.each([
    ['chain ID', { chainId: 5_042_002 }],
    ['same token', { tokenOutAddress: USDC }],
    ['unknown token', { tokenOutAddress: USER }],
    ['zero amount', { amountIn: '0' }],
    ['non-canonical amount', { amountIn: '01' }],
    ['oversized decimal input', { amountIn: '1'.repeat(40) }],
    ['amount above uint128', { amountIn: (1n << 128n).toString() }],
    ['treasury wallet', { walletControl: 'treasury' }],
    ['custody wallet', { walletControl: 'custody' }],
    ['fallback provider', { walletControl: 'fallback-provider' }],
    ['malformed wallet', { walletAddress: 'not-an-address' }],
    [
      'zero recipient',
      { recipient: '0x0000000000000000000000000000000000000000' },
    ],
    [
      'different recipient',
      { recipient: '0x2234567890123456789012345678901234567890' },
    ],
    ['developer wallet', { walletControl: 'developer-controlled' }],
    ['Circle App Wallet', { walletControl: 'circle-app-wallet-uc' }],
    ['zero slippage', { slippageBps: 0 }],
    ['fractional slippage', { slippageBps: 1.5 }],
    ['excessive slippage', { slippageBps: 501 }],
    ['fractional deadline', { deadline: NOW + 1.5 }],
    ['expired deadline', { deadline: NOW }],
    ['excessive deadline', { deadline: NOW + 1_201 }],
  ])('rejects invalid %s', (_label, overrides) => {
    expect(() => service.validateBoundary(request(overrides), NOW)).toThrow(
      HttpException,
    );
  });

  it('fails closed with every unresolved evidence gate', () => {
    try {
      service.requireExecutable();
      throw new Error('expected requireExecutable to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const response = (error as HttpException).getResponse();
      expect(response).toMatchObject({
        code: ARC_MAINNET_UNISWAP_V4_ERROR_CODES.UNAVAILABLE,
        blockers: [
          'UNISWAP_USDC_EURC_POOL_UNIQUENESS_NOT_VERIFIED',
          'UNISWAP_USDC_EURC_LIQUIDITY_NOT_VERIFIED',
          'ARC_MAINNET_RPC_QUORUM_UNAVAILABLE',
          'ARC_MAINNET_UNISWAP_EXECUTION_AUTHORIZATION_UNAVAILABLE',
        ],
      });
    }
  });
});
