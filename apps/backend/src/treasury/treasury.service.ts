import { Injectable } from '@nestjs/common';
import { CircleAdapter } from '../adapters/circle/circle.adapter';
import { CircleClient } from '../adapters/circle/circle.client';

type CircleTreasuryWallet = {
  id: string;
};

type CircleTreasuryWalletSet = {
  id: string;
};

type TreasuryWalletConfig = {
  walletAddress: string | undefined;
  walletId: string | undefined;
  walletSetId: string | undefined;
  blockchain: string;
  balance?: { amount: string; symbol: string } | null;
};

@Injectable()
export class TreasuryService {
  constructor(
    private readonly circleAdapter: CircleAdapter,
    private readonly circleClient: CircleClient,
  ) {}

  async initializeTreasury() {
    console.log('Creating wallet set...');
    const walletSet =
      (await this.circleAdapter.createWalletSet()) as CircleTreasuryWalletSet;
    const wallet = (await this.circleAdapter.createWallet(
      walletSet.id,
    )) as CircleTreasuryWallet;

    console.log('Wallet created:', wallet.id);

    return {
      walletSetId: walletSet.id,
      walletId: wallet.id,
    };
  }

  async getTreasuryWallet(blockchain: string): Promise<TreasuryWalletConfig | null> {
    // Return the pre-configured treasury wallet based on the backend environment variables
    const isArc = blockchain === 'ARC-TESTNET';
    const isSepolia = blockchain === 'ETH-SEPOLIA';
    const isSolana = blockchain === 'SOLANA-DEVNET';

    let config: TreasuryWalletConfig | null = null;

    if (isArc) {
      config = {
        walletId: process.env.CIRCLE_WALLET_ID_ARC,
        walletSetId: process.env.CIRCLE_WALLET_SET_ID_ARC,
        walletAddress: process.env.CIRCLE_WALLET_ADDRESS_ARC,
        blockchain,
      };
    } else if (isSepolia) {
      config = {
        walletId: process.env.CIRCLE_WALLET_ID_SEPOLIA,
        walletSetId: process.env.CIRCLE_WALLET_SET_ID_SEPOLIA,
        walletAddress: process.env.CIRCLE_WALLET_ADDRESS_SEPOLIA,
        blockchain,
      };
    } else if (isSolana) {
      config = {
        walletId: process.env.CIRCLE_WALLET_ID_SOLANA,
        walletSetId: process.env.CIRCLE_WALLET_SET_ID_SOLANA,
        walletAddress: process.env.CIRCLE_WALLET_ADDRESS_SOLANA,
        blockchain,
      };
    }

    if (!config || !config.walletId) {
      return null;
    }

    try {
      const response = await this.circleClient.getWalletClient().getWalletTokenBalance({
        id: config.walletId
      });
      
      const balances = response?.data?.tokenBalances || [];
      const usdcBalance = balances.find((b: any) => b.token?.symbol === 'USDC');
      
      if (usdcBalance) {
        config.balance = {
          amount: usdcBalance.amount,
          symbol: 'USDC'
        };
      } else {
        config.balance = {
          amount: '0',
          symbol: 'USDC'
        };
      }
    } catch (error) {
      console.error(`Failed to fetch balance for treasury wallet ${config.walletId}:`, error);
      config.balance = null;
    }

    return config;
  }
}
