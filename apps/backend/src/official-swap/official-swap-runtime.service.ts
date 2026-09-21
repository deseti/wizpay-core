import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OFFICIAL_SWAP_ALLOWED_CHAIN,
  OFFICIAL_SWAP_MAINNET_EXECUTOR,
  type OfficialSwapExecutorConfigured,
} from './official-swap.types';

export interface OfficialSwapRuntimeStatus {
  readinessAvailable: boolean;
  executorConfigured: OfficialSwapExecutorConfigured;
  enabled: boolean;
  chain: typeof OFFICIAL_SWAP_ALLOWED_CHAIN;
}

@Injectable()
export class OfficialSwapRuntimeService {
  constructor(private readonly configService: ConfigService) {}

  async getRuntimeStatus(): Promise<OfficialSwapRuntimeStatus> {
    return {
      readinessAvailable: true,
      executorConfigured: this.getExecutorConfigured(),
      enabled:
        this.configService.get<string>('WIZPAY_OFFICIAL_SWAP_ENABLED') ===
        'true',
      chain: OFFICIAL_SWAP_ALLOWED_CHAIN,
    };
  }

  private getExecutorConfigured(): OfficialSwapExecutorConfigured {
    const executor = this.configService.get<string>(
      'WIZPAY_OFFICIAL_SWAP_EXECUTOR',
    );

    if (!executor?.trim()) {
      return 'disabled';
    }

    if (executor === OFFICIAL_SWAP_MAINNET_EXECUTOR) {
      return OFFICIAL_SWAP_MAINNET_EXECUTOR;
    }

    return 'unsupported';
  }
}
