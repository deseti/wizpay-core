import { Injectable } from '@nestjs/common';
import { CircleAdapter } from '../adapters/circle/circle.adapter';

@Injectable()
export class TreasuryService {
  constructor(private readonly circleAdapter: CircleAdapter) {}

  async initializeTreasury() {
    console.log("Creating wallet set...");
    const walletSet = await this.circleAdapter.createWalletSet();
    const wallet = await this.circleAdapter.createWallet(walletSet.id);

    console.log("Wallet created:", wallet.id);

    return {
      walletSetId: walletSet.id,
      walletId: wallet.id
    };
  }
}
