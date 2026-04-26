import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { randomUUID } from 'crypto';

@Injectable()
export class CircleAdapter {
  private readonly baseUrl = process.env.CIRCLE_BASE_URL || 'https://api.circle.com';
  private get apiKey() {
    return process.env.CIRCLE_API_KEY;
  }

  async createWalletSet() {
    if (!this.apiKey) {
      throw new InternalServerErrorException('server is missing Circle treasury wallet credentials');
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/w3s/developer/walletSets`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          name: 'Treasury Wallet Set',
        }),
      });

      if (!response.ok) {
        const errObj = await response.json().catch(() => ({}));
        throw new Error(`Circle API error: ${response.status} - ${JSON.stringify(errObj)}`);
      }

      const data = await response.json();
      return data.data.walletSet;
    } catch (error) {
      console.error('Circle initialization failed:', error);
      throw new InternalServerErrorException('Circle initialization failed');
    }
  }

  async createWallet(walletSetId: string) {
    if (!this.apiKey) {
      throw new InternalServerErrorException('server is missing Circle treasury wallet credentials');
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/w3s/developer/wallets`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          idempotencyKey: randomUUID(),
          walletSetId,
          blockchains: ['ETH-SEPOLIA'],
          count: 1,
          accountType: 'SCA'
        }),
      });

      if (!response.ok) {
        const errObj = await response.json().catch(() => ({}));
        throw new Error(`Circle API error: ${response.status} - ${JSON.stringify(errObj)}`);
      }

      const data = await response.json();
      return data.data.wallets[0];
    } catch (error) {
      console.error('Circle initialization failed:', error);
      throw new InternalServerErrorException('Circle initialization failed');
    }
  }
}
