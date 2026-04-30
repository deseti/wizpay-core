import { Injectable, Logger } from '@nestjs/common';
import { CircleClient } from './circle.client';
import { CircleDeveloperControlledWalletsClient, FeeLevel, TokenBlockchain, Blockchain } from '@circle-fin/developer-controlled-wallets';
import { randomUUID } from 'crypto';

export interface CreateWalletInput {
  blockchain: string;
  walletSetId?: string;
  name?: string;
  refId?: string;
}

export interface ExecuteTransferInput {
  walletId?: string;
  walletAddress?: string;
  blockchain: string;
  destinationAddress: string;
  amount: string;
  tokenAddress: string;
  referenceId?: string;
  feeLevel?: FeeLevel;
}

export interface CircleTransferResult {
  transferId: string;
  status: 'pending' | 'completed' | 'failed';
  raw?: any;
}

@Injectable()
export class CircleTransferService {
  private readonly logger = new Logger(CircleTransferService.name);

  constructor(private readonly circleClient: CircleClient) {}

  async createWallet(input: CreateWalletInput) {
    this.logger.log(`Creating wallet for ${input.blockchain}`);
    const client = this.circleClient.getWalletClient();
    
    let walletSetId = input.walletSetId;
    if (!walletSetId) {
      const setResponse = await client.createWalletSet({
        name: 'WizPay Backend Wallet Set',
        xRequestId: randomUUID(),
      });
      walletSetId = setResponse.data?.walletSet?.id;
      if (!walletSetId) {
        throw new Error('Circle did not return the created wallet set identifier.');
      }
    }

    const walletResponse = await client.createWallets({
      blockchains: [input.blockchain as Blockchain],
      count: 1,
      walletSetId,
      metadata: [
        {
          name: input.name || `WizPay Backend Wallet ${input.blockchain}`,
          refId: input.refId,
        },
      ],
      xRequestId: randomUUID(),
    });

    const wallet = walletResponse.data?.wallets?.[0];
    if (!wallet) {
      throw new Error('Circle did not return the created wallet.');
    }

    return wallet;
  }

  async executeTransfer(input: ExecuteTransferInput): Promise<CircleTransferResult> {
    this.logger.log(`Executing transfer to ${input.destinationAddress} on ${input.blockchain}`);
    const client = this.circleClient.getWalletClient();
    const requestId = randomUUID();

    const request = input.walletId
      ? {
          walletId: input.walletId,
          tokenAddress: input.tokenAddress,
          amount: [input.amount],
          destinationAddress: input.destinationAddress,
          refId: input.referenceId,
          fee: {
            type: 'level' as const,
            config: { feeLevel: input.feeLevel || 'MEDIUM' },
          },
          xRequestId: requestId,
        }
      : {
          walletAddress: input.walletAddress!,
          blockchain: input.blockchain as TokenBlockchain,
          tokenAddress: input.tokenAddress,
          amount: [input.amount],
          destinationAddress: input.destinationAddress,
          refId: input.referenceId,
          fee: {
            type: 'level' as const,
            config: { feeLevel: input.feeLevel || 'MEDIUM' },
          },
          xRequestId: requestId,
        };

    try {
      const response = await client.createTransaction(request);
      const createdTransfer = response.data;

      if (!createdTransfer?.id) {
        throw new Error('Circle did not return a transfer identifier.');
      }

      return {
        transferId: createdTransfer.id,
        status: createdTransfer.state === 'FAILED' ? 'failed' : 'pending',
        raw: createdTransfer,
      };
    } catch (error) {
      this.logger.error('Transfer execution failed', error);
      throw error;
    }
  }

  async signTransaction(payload: any) {
    this.logger.log('Signing transaction');
    // Implement if needed by specific flow, normally handled by createTransaction
    throw new Error('Method not implemented.');
  }
}