import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  CIRCLE_CONFIGURATION_ERROR_CODES,
  CircleConfigurationError,
  resolveCircleConfigurationFromService,
} from '../../config/circle-execution.config';

@Injectable()
export class CircleAdapter {
  constructor(private readonly config: ConfigService) {}

  private get circle() {
    return resolveCircleConfigurationFromService(
      this.config,
      'developer-controlled',
    );
  }

  async createWalletSet() {
    throw new CircleConfigurationError(
      CIRCLE_CONFIGURATION_ERROR_CODES.WALLET_SET_MISMATCH,
      'Runtime wallet-set creation is disabled; use the selected network wallet set.',
    );
  }

  async createWallet(walletSetId: string) {
    try {
      if (walletSetId !== this.circle.walletSetId) {
        throw new Error(
          'Circle wallet set does not match selected configuration.',
        );
      }
      const response = await fetch(
        `${this.circle.apiBaseUrl}/v1/w3s/developer/wallets`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.circle.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            idempotencyKey: randomUUID(),
            walletSetId,
            blockchains: [this.circle.blockchain],
            count: 1,
            accountType: 'SCA',
          }),
        },
      );

      if (!response.ok) {
        const errObj = await response.json().catch(() => ({}));
        throw new Error(
          `Circle API error: ${response.status} - ${JSON.stringify(errObj)}`,
        );
      }

      const data = await response.json();
      return data.data.wallets[0];
    } catch (error) {
      if (error instanceof CircleConfigurationError) throw error;
      throw new InternalServerErrorException('Circle initialization failed');
    }
  }
}
