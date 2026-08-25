import { Injectable, Logger } from '@nestjs/common';
import {
  CircleDeveloperControlledWalletsClient,
  initiateDeveloperControlledWalletsClient,
} from '@circle-fin/developer-controlled-wallets';

@Injectable()
export class CircleClient {
  private readonly logger = new Logger(CircleClient.name);
  private walletClient: CircleDeveloperControlledWalletsClient;

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
}
