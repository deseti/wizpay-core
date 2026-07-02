import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { WizPayAnalyticsSnapshot } from './analytics.types';

const DEFAULT_WIZPAY_CONTRACT_ADDRESS =
  '0x87ACE45582f45cC81AC1E627E875AE84cbd75946';
const DEFAULT_ARCSCAN_API_BASE_URL = 'https://testnet.arcscan.app/api/v2';

@Injectable()
export class AnalyticsService {
  private cache: WizPayAnalyticsSnapshot = this.createSeedSnapshot();

  getWizPayAnalytics(): WizPayAnalyticsSnapshot {
    return this.cloneSnapshot(this.cache);
  }

  updateWizPayAnalytics(): WizPayAnalyticsSnapshot {
    const cronSecret = process.env.ANALYTICS_CRON_SECRET?.trim();

    if (!cronSecret) {
      throw new ServiceUnavailableException({
        code: 'ANALYTICS_CRON_SECRET_MISSING',
        message: 'Analytics update is unavailable until the cron secret is set.',
      });
    }

    this.refreshArcscanCountersMetadata();

    this.cache = {
      ...this.cache,
      contractAddress: this.resolveContractAddress(),
      updatedAt: new Date().toISOString(),
      source: 'verified_seed_cache_updated_by_backend_cron',
    };

    return this.getWizPayAnalytics();
  }

  getCronSecret(): string | undefined {
    const secret = process.env.ANALYTICS_CRON_SECRET?.trim();
    return secret || undefined;
  }

  private createSeedSnapshot(): WizPayAnalyticsSnapshot {
    return {
      contractName: 'WizPay',
      network: 'Arc Testnet',
      contractAddress: this.resolveContractAddress(),
      transactions: 20996,
      transfers: 336994,
      gasUsed: 8356116679,
      balance: '0.384534 USDC',
      lastBalanceUpdateBlock: 49832717,
      updatedAt: new Date().toISOString(),
      source: 'verified_seed_cache',
      volume: {
        source: 'Arcscan token transfer CSV export',
        coverage: 'from contract deployment to export timestamp',
        amountFormat: 'normalized token display amounts from Arcscan export',
        tokenDecimals: 6,
        settledVolume: 373500000,
        settledVolumeDisplay: '373.5M+',
        grossMovement: 747100000,
        grossMovementDisplay: '747.1M+',
        totalIn: 373600000,
        totalOut: 373500000,
        net: 100000,
        tokens: [
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
        ],
      },
    };
  }

  private resolveContractAddress(): string {
    return (
      process.env.WIZPAY_ANALYTICS_CONTRACT_ADDRESS?.trim() ||
      DEFAULT_WIZPAY_CONTRACT_ADDRESS
    );
  }

  private refreshArcscanCountersMetadata(): void {
    const arcscanApiBaseUrl =
      process.env.ARCSCAN_API_BASE_URL?.trim() || DEFAULT_ARCSCAN_API_BASE_URL;
    void arcscanApiBaseUrl;

    // TODO: Add a lightweight Arcscan counter refresh here only after the
    // endpoint shape, pagination limits, and failure behavior are documented.
    // This first version intentionally never fetches full token-transfer pages.
  }

  private cloneSnapshot(
    snapshot: WizPayAnalyticsSnapshot,
  ): WizPayAnalyticsSnapshot {
    return {
      ...snapshot,
      volume: {
        ...snapshot.volume,
        tokens: snapshot.volume.tokens.map((token) => ({ ...token })),
      },
    };
  }
}
