import { UnauthorizedException } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

describe('AnalyticsController', () => {
  let controller: AnalyticsController;
  let service: AnalyticsService;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    service = new AnalyticsService();
    controller = new AnalyticsController(service);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns seed WizPay analytics', () => {
    const analytics = controller.getWizPayAnalytics();

    expect(analytics).toMatchObject({
      contractName: 'WizPay',
      network: 'Arc Testnet',
      contractAddress: '0x87ACE45582f45cC81AC1E627E875AE84cbd75946',
      transactions: 20996,
      transfers: 336994,
      gasUsed: 8356116679,
      balance: '0.384534 USDC',
      lastBalanceUpdateBlock: 49832717,
      source: 'verified_seed_cache',
      volume: {
        settledVolume: 373500000,
        settledVolumeDisplay: '373.5M+',
        grossMovement: 747100000,
        grossMovementDisplay: '747.1M+',
        totalIn: 373600000,
        totalOut: 373500000,
        net: 100000,
      },
    });
    expect(analytics.volume.tokens).toEqual([
      {
        symbol: 'USDC',
        decimals: 6,
        in: 187100000,
        out: 187100000,
        gross: 374200000,
        net: 0,
      },
      {
        symbol: 'EURC',
        decimals: 6,
        in: 186500000,
        out: 186400000,
        gross: 372900000,
        net: 100000,
      },
    ]);
    expect(Date.parse(analytics.updatedAt)).not.toBeNaN();
  });

  it('rejects update without Authorization', () => {
    process.env.ANALYTICS_CRON_SECRET = 'cron-secret';

    expect(() => controller.updateWizPayAnalytics()).toThrow(
      UnauthorizedException,
    );
  });

  it('rejects update with invalid Authorization', () => {
    process.env.ANALYTICS_CRON_SECRET = 'cron-secret';

    expect(() =>
      controller.updateWizPayAnalytics('Bearer wrong-secret'),
    ).toThrow(UnauthorizedException);
  });

  it('returns analytics JSON when Authorization is valid', () => {
    process.env.ANALYTICS_CRON_SECRET = 'cron-secret';
    const before = controller.getWizPayAnalytics();

    const analytics = controller.updateWizPayAnalytics('Bearer cron-secret');

    expect(analytics).toMatchObject({
      contractName: 'WizPay',
      network: 'Arc Testnet',
      contractAddress: '0x87ACE45582f45cC81AC1E627E875AE84cbd75946',
      transactions: 20996,
      transfers: 336994,
      source: 'verified_seed_cache_updated_by_backend_cron',
      volume: {
        settledVolumeDisplay: '373.5M+',
        grossMovementDisplay: '747.1M+',
      },
    });
    expect(Date.parse(analytics.updatedAt)).not.toBeNaN();
    expect(analytics.updatedAt >= before.updatedAt).toBe(true);
  });
});
