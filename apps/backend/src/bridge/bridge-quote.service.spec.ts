import { ConfigService } from '@nestjs/config';
import {
  BridgeQuoteService,
  calculateFastMaxFee,
  calculateFastProtocolFee,
  parseCircleMinimumFeeBps,
  parseFastAllowanceSubunits,
} from './bridge-quote.service';

function config(): ConfigService {
  return { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
}

describe('bridge fast fee math (authoritative Circle model)', () => {
  it('parses the Fast minimumFee for the requested route', () => {
    const bps = parseCircleMinimumFeeBps(
      [
        { sourceDomain: 6, destinationDomain: 26, finalityThreshold: 1000, minimumFee: 1.3 },
        { sourceDomain: 6, destinationDomain: 26, finalityThreshold: 2000, minimumFee: 0 },
      ],
      6,
      26,
    );
    expect(bps).toBe(1.3);
  });

  it('computes the Base 10 USDC protocol fee at 1.3 bps', () => {
    expect(calculateFastProtocolFee(10_000_000n, 1.3)).toBe(1300n);
  });

  it('ceils sub-unit fees so Circle never sees insufficient_fee', () => {
    expect(calculateFastProtocolFee(5000n, 0.325)).toBe(1n);
    expect(calculateFastMaxFee(1n)).toBe(2n);
  });

  it('adds a 20% buffer to maxFee', () => {
    expect(calculateFastMaxFee(1300n)).toBe(1560n);
    expect(calculateFastMaxFee(0n)).toBe(0n);
  });

  it('parses allowance without float loss', () => {
    expect(parseFastAllowanceSubunits(123999.999999)).toBe(123_999_999_999n);
    expect(parseFastAllowanceSubunits('10')).toBe(10_000_000n);
  });

  it('quotes Standard routes without network calls', async () => {
    const service = new BridgeQuoteService(config());
    await expect(
      service.quote('ARC-MAINNET', 'BASE-MAINNET', '10000000'),
    ).resolves.toMatchObject({
      transferMode: 'standard',
      minFinalityThreshold: 2000,
      protocolFee: '0',
      receiveAmount: '10000000',
    });
  });

  it('fails closed for Fast routes when Circle is unreachable', async () => {
    const service = new BridgeQuoteService(config());
    const realFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as never;
    try {
      await expect(
        service.quote('BASE-MAINNET', 'ARC-MAINNET', '10000000'),
      ).rejects.toMatchObject({ response: { code: 'BRIDGE_FAST_UNAVAILABLE' } });
    } finally {
      global.fetch = realFetch;
    }
  });
});
