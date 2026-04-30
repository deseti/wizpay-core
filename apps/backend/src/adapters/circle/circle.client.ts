import { Injectable, Logger } from '@nestjs/common';
import { CircleDeveloperControlledWalletsClient, initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';

@Injectable()
export class CircleClient {
  private readonly logger = new Logger(CircleClient.name);
  private walletClient: CircleDeveloperControlledWalletsClient;
  private bridgeKit: unknown | null = null;
  private bridgeAdapter: unknown | null = null;

  constructor() {
    const apiKey = process.env.CIRCLE_API_KEY || '';
    const entitySecret = process.env.CIRCLE_ENTITY_SECRET || '';

    this.walletClient = initiateDeveloperControlledWalletsClient({
      apiKey,
      entitySecret,
    });

    this.logger.log('Circle wallet SDK client initialized');
  }

  getWalletClient(): CircleDeveloperControlledWalletsClient {
    return this.walletClient;
  }

  async getBridgeClient(): Promise<any> {
    if (!this.bridgeKit) {
      const { BridgeKit } = await import('@circle-fin/bridge-kit');
      this.bridgeKit = new BridgeKit();
    }

    return this.bridgeKit;
  }

  async getBridgeAdapter(): Promise<any> {
    if (!this.bridgeAdapter) {
      const { createCircleWalletsAdapter } = await import(
        '@circle-fin/adapter-circle-wallets'
      );

      this.bridgeAdapter = createCircleWalletsAdapter({
        apiKey: process.env.CIRCLE_API_KEY || '',
        entitySecret: process.env.CIRCLE_ENTITY_SECRET || '',
      });
    }

    return this.bridgeAdapter;
  }
}
