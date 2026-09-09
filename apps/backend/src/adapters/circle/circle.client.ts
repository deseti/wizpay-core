import { Injectable, Logger } from '@nestjs/common';
import {
  CircleDeveloperControlledWalletsClient,
  initiateDeveloperControlledWalletsClient,
} from '@circle-fin/developer-controlled-wallets';
import { ConfigService } from '@nestjs/config';
import { resolveCircleConfigurationFromService } from '../../config/circle-execution.config';

@Injectable()
export class CircleClient {
  private readonly logger = new Logger(CircleClient.name);
  private walletClient: CircleDeveloperControlledWalletsClient | null = null;

  constructor(private readonly config: ConfigService) {}

  getWalletClient(): CircleDeveloperControlledWalletsClient {
    if (this.walletClient) return this.walletClient;
    const circle = resolveCircleConfigurationFromService(
      this.config,
      'developer-controlled',
    );
    this.walletClient = initiateDeveloperControlledWalletsClient({
      apiKey: circle.apiKey,
      entitySecret: circle.entitySecret!,
      baseUrl: circle.apiBaseUrl,
    });
    return this.walletClient;
  }
}
