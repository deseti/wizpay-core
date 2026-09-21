import { MainnetUniswapV4ReadinessService } from './mainnet-uniswap-v4-readiness.service';
import { MainnetUniswapV4Service } from './mainnet-uniswap-v4.service';
import {
  ARC_MAINNET_UNISWAP_V4_EURC,
  ARC_MAINNET_UNISWAP_V4_USDC,
} from './mainnet-uniswap-v4-protocol';

const USER = '0x1234567890123456789012345678901234567890';

// Simulates a 0.864 output rate with live-quote shape.
function liveQuoteMock() {
  return {
    liveQuote: jest.fn(
      async (normalized: {
        amountIn: bigint;
        tokenInAddress: string;
        tokenOutAddress: string;
        slippageBps: number;
      }) => {
        const out = (normalized.amountIn * 864_736n) / 1_000_000n;
        const minOut =
          (out * (10_000n - BigInt(normalized.slippageBps))) / 10_000n;
        return {
          observation: { blockNumber: 100 },
          validated: { minAmountOut: minOut, minHopPriceX36: 1n },
          quotedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          expiresAtBlock: 160,
        };
      },
    ),
    assertQuoteFresh: jest.fn().mockResolvedValue(undefined),
    assertLiveStaticQuorum: jest.fn().mockResolvedValue(undefined),
    payrollFeeBps: jest.fn().mockResolvedValue(25n),
  };
}

function service() {
  const quotes = liveQuoteMock();
  const instance = new MainnetUniswapV4Service(
    new MainnetUniswapV4ReadinessService(),
    quotes as never,
    { get: () => ({ key: 'arc-mainnet' }) } as never,
  );
  return instance;
}

function payrollRequest(overrides: Record<string, unknown> = {}) {
  return {
    tokenInAddress: ARC_MAINNET_UNISWAP_V4_USDC,
    tokenOutAddress: ARC_MAINNET_UNISWAP_V4_EURC,
    outputTotals: '1000000',
    slippageBps: 200,
    walletAddress: USER,
    recipient: USER,
    ...overrides,
  };
}

describe('payrollCrossTokenQuote', () => {
  it('solves gross input above obligations (never 1:1)', async () => {
    const result = await service().payrollCrossTokenQuote(payrollRequest());
    expect(BigInt(result.grossInput)).toBeGreaterThan(BigInt(result.obligations));
    expect(BigInt(result.minTotalOut)).toBeGreaterThanOrEqual(
      BigInt(result.obligations),
    );
    expect(BigInt(result.feeAmount)).toBeGreaterThan(0n);
    expect(result.payrollFeeBps).toBe('25');
  });

  it('fails closed for same-token input', async () => {
    await expect(
      service().payrollCrossTokenQuote(
        payrollRequest({ tokenOutAddress: ARC_MAINNET_UNISWAP_V4_USDC }),
      ),
    ).rejects.toThrow();
  });

  it('fails closed when obligations are not canonical', async () => {
    await expect(
      service().payrollCrossTokenQuote(payrollRequest({ outputTotals: '1.5' })),
    ).rejects.toThrow();
  });
});
