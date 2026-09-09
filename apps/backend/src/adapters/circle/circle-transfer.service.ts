import { Injectable, Logger } from '@nestjs/common';
import { CircleClient } from './circle.client';
import {
  CircleDeveloperControlledWalletsClient,
  FeeLevel,
  TokenBlockchain,
  Blockchain,
} from '@circle-fin/developer-controlled-wallets';
import { randomUUID } from 'crypto';
import { ConfigService } from '@nestjs/config';
import {
  CIRCLE_CONFIGURATION_ERROR_CODES,
  CircleConfigurationError,
  resolveCircleConfigurationFromService,
} from '../../config/circle-execution.config';
import type { BackendArcNetworkConfiguration } from '../../config/arc-network.config';
import { getAddress, isAddressEqual } from 'viem';

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

  constructor(
    private readonly circleClient: CircleClient,
    private readonly config: ConfigService,
  ) {}

  private get circle() {
    return resolveCircleConfigurationFromService(
      this.config,
      'developer-controlled',
    );
  }

  async createWallet(input: CreateWalletInput) {
    if (input.blockchain !== this.circle.blockchain) {
      throw new CircleConfigurationError(
        CIRCLE_CONFIGURATION_ERROR_CODES.CREDENTIAL_ENVIRONMENT_MISMATCH,
        'Wallet creation blockchain does not match the selected Arc network.',
      );
    }
    if (input.walletSetId !== this.circle.walletSetId) {
      throw new CircleConfigurationError(
        CIRCLE_CONFIGURATION_ERROR_CODES.WALLET_SET_MISMATCH,
        'Wallet creation requires the selected network wallet set.',
      );
    }
    this.logger.log(`Creating wallet for ${input.blockchain}`);
    const client = this.circleClient.getWalletClient();

    const walletResponse = await client.createWallets({
      blockchains: [input.blockchain as Blockchain],
      count: 1,
      walletSetId: input.walletSetId,
      metadata: [
        {
          name: input.name || `WizPay Backend Wallet ${input.blockchain}`,
          refId: input.refId,
        },
      ],
      xRequestId: randomUUID(),
    });

    const wallet = walletResponse.data?.wallets?.[0];
    if (
      !wallet ||
      wallet.blockchain !== this.circle.blockchain ||
      wallet.walletSetId !== this.circle.walletSetId
    ) {
      throw new Error('Circle did not return the created wallet.');
    }

    return wallet;
  }

  async executeTransfer(
    input: ExecuteTransferInput,
  ): Promise<CircleTransferResult> {
    if (input.blockchain !== this.circle.blockchain) {
      throw new CircleConfigurationError(
        CIRCLE_CONFIGURATION_ERROR_CODES.CREDENTIAL_ENVIRONMENT_MISMATCH,
        'Transfer blockchain does not match the selected Arc network.',
      );
    }
    if (input.walletId && input.walletId !== this.circle.walletId) {
      throw new CircleConfigurationError(
        CIRCLE_CONFIGURATION_ERROR_CODES.WALLET_SET_MISMATCH,
        'Transfer wallet does not match selected configuration.',
      );
    }
    if (
      input.walletAddress &&
      (!this.circle.walletAddress ||
        !isAddressEqual(
          getAddress(input.walletAddress),
          getAddress(this.circle.walletAddress),
        ))
    ) {
      throw new CircleConfigurationError(
        CIRCLE_CONFIGURATION_ERROR_CODES.WALLET_BLOCKCHAIN_MISMATCH,
        'Transfer wallet address does not match selected configuration.',
      );
    }
    if (!input.walletId && !input.walletAddress) {
      throw new CircleConfigurationError(
        CIRCLE_CONFIGURATION_ERROR_CODES.MISSING,
        'Transfer requires the selected Circle wallet identity.',
      );
    }
    const arcNetwork =
      this.config.getOrThrow<BackendArcNetworkConfiguration>('arcNetwork');
    if (
      !Object.values(arcNetwork.tokens).some((token) =>
        isAddressEqual(
          getAddress(token.address),
          getAddress(input.tokenAddress),
        ),
      )
    ) {
      throw new CircleConfigurationError(
        CIRCLE_CONFIGURATION_ERROR_CODES.WALLET_BLOCKCHAIN_MISMATCH,
        'Transfer token does not belong to the selected Arc network.',
      );
    }
    this.logger.log(
      `Executing transfer to ${input.destinationAddress} on ${input.blockchain}`,
    );
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
      this.logger.error('Transfer execution failed.');
      throw error;
    }
  }

  async signTransaction(payload: any) {
    this.logger.log('Signing transaction');
    // Implement if needed by specific flow, normally handled by createTransaction
    throw new Error('Method not implemented.');
  }
}
