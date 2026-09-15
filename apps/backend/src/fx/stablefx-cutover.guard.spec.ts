import { BadRequestException } from '@nestjs/common';
import {
  assertLegacyLiquidityEnabled,
  isLegacyLiquidityEnabled,
} from './stablefx-cutover.guard';

describe('legacy liquidity Mainnet cutover guard', () => {
  const original = process.env.WIZPAY_ENABLE_LEGACY_LIQUIDITY;

  afterEach(() => {
    if (original === undefined) delete process.env.WIZPAY_ENABLE_LEGACY_LIQUIDITY;
    else process.env.WIZPAY_ENABLE_LEGACY_LIQUIDITY = original;
  });

  it('cannot be enabled on Arc Mainnet by the legacy environment flag', () => {
    process.env.WIZPAY_ENABLE_LEGACY_LIQUIDITY = 'true';

    expect(isLegacyLiquidityEnabled('arc-mainnet')).toBe(false);
    try {
      assertLegacyLiquidityEnabled('arc-mainnet');
      throw new Error('Expected the Arc Mainnet liquidity guard to reject.');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      const response = error.getResponse();
      expect(response).toEqual(
        expect.objectContaining({ code: 'MAINNET_LIQUIDITY_FORBIDDEN' }),
      );
    }
  });

  it('preserves explicit isolated Testnet enablement', () => {
    process.env.WIZPAY_ENABLE_LEGACY_LIQUIDITY = 'true';

    expect(isLegacyLiquidityEnabled('arc-testnet')).toBe(true);
    expect(() => assertLegacyLiquidityEnabled('arc-testnet')).not.toThrow();
  });
});
