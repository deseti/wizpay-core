import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  isAddressEqual,
  parseAbiItem,
  type Address,
  type Hash,
  type PublicClient,
} from 'viem';
import type { BackendArcNetworkConfiguration } from '../../config/arc-network.config';
import {
  CIRCLE_CONFIGURATION_ERROR_CODES,
  CircleConfigurationError,
  resolveCircleConfigurationFromService,
} from '../../config/circle-execution.config';

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export class CircleReceiptVerificationError extends CircleConfigurationError {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(
      CIRCLE_CONFIGURATION_ERROR_CODES.RECEIPT_VERIFICATION_FAILED,
      message,
    );
    this.name = 'CircleReceiptVerificationError';
  }
}

export type VerifyCircleTransferReceiptInput = Readonly<{
  transactionHash: Hash;
  senderAddress?: Address | null;
  recipientAddress: Address;
  tokenAddress: Address;
  amountUnits: bigint;
  circleBlockchain?: string | null;
}>;

@Injectable()
export class CircleReceiptVerifierService {
  private readonly arcNetwork: BackendArcNetworkConfiguration;
  private publicClient: PublicClient;

  constructor(private readonly config: ConfigService) {
    this.arcNetwork =
      config.getOrThrow<BackendArcNetworkConfiguration>('arcNetwork');
    this.publicClient = createPublicClient({
      chain: {
        id: this.arcNetwork.chainId,
        name: this.arcNetwork.key,
        nativeCurrency: { decimals: 18, name: 'USDC', symbol: 'USDC' },
        rpcUrls: { default: { http: [this.arcNetwork.rpcUrl] } },
      },
      transport: http(this.arcNetwork.rpcUrl, {
        retryCount: 1,
        timeout: 10_000,
      }),
    });
  }

  async verifyTransfer(input: VerifyCircleTransferReceiptInput): Promise<void> {
    const circle = resolveCircleConfigurationFromService(
      this.config,
      'developer-controlled',
    );
    if (
      circle.receiptVerification.chainId !== this.arcNetwork.chainId ||
      input.circleBlockchain !== circle.blockchain
    ) {
      this.reject(
        'Circle transaction blockchain does not match selected Arc network.',
      );
    }
    const senderValue = input.senderAddress ?? circle.walletAddress;
    if (!senderValue)
      this.reject('Expected Circle wallet address is unavailable.');
    const sender = getAddress(senderValue);
    if (
      !circle.walletAddress ||
      !isAddressEqual(sender, getAddress(circle.walletAddress))
    ) {
      this.reject(
        'Circle transaction sender does not match selected wallet configuration.',
      );
    }

    let transaction;
    let receipt;
    try {
      const providerChainId = await this.publicClient.getChainId();
      if (providerChainId !== this.arcNetwork.chainId) {
        this.reject('Receipt provider is connected to the wrong Arc network.');
      }
      [transaction, receipt] = await Promise.all([
        this.publicClient.getTransaction({ hash: input.transactionHash }),
        this.publicClient.getTransactionReceipt({
          hash: input.transactionHash,
        }),
      ]);
    } catch (error) {
      if (error instanceof CircleReceiptVerificationError) throw error;
      throw new CircleReceiptVerificationError(
        'The selected Arc receipt is not available yet.',
        true,
      );
    }
    if (!receipt) {
      throw new CircleReceiptVerificationError(
        'The selected Arc receipt is not available yet.',
        true,
      );
    }
    if (receipt.status !== 'success')
      this.reject('Circle transaction receipt failed.');
    if (
      transaction.hash.toLowerCase() !== input.transactionHash.toLowerCase() ||
      receipt.transactionHash.toLowerCase() !==
        input.transactionHash.toLowerCase()
    ) {
      this.reject(
        'RPC transaction hash does not match the Circle transaction.',
      );
    }
    if (transaction.chainId !== this.arcNetwork.chainId)
      this.reject('Circle transaction was submitted on the wrong chain.');
    if (!transaction.to || !isAddressEqual(transaction.to, input.tokenAddress))
      this.reject(
        'Circle transaction target does not match the expected token contract.',
      );
    if (!isAddressEqual(transaction.from, sender))
      this.reject(
        'Circle transaction sender does not match the configured wallet.',
      );
    if (transaction.value !== 0n)
      this.reject('Circle token transfer unexpectedly included native value.');

    const matches = receipt.logs.flatMap((log) => {
      if (!isAddressEqual(log.address, input.tokenAddress)) return [];
      try {
        const decoded = decodeEventLog({
          abi: [TRANSFER_EVENT],
          data: log.data,
          topics: log.topics,
        });
        if (
          decoded.eventName === 'Transfer' &&
          isAddressEqual(getAddress(decoded.args.from), sender) &&
          isAddressEqual(getAddress(decoded.args.to), input.recipientAddress) &&
          decoded.args.value === input.amountUnits
        ) {
          return [log];
        }
      } catch {
        // Ignore logs that are not canonical ERC-20 Transfer events.
      }
      return [];
    });
    if (matches.length !== 1)
      this.reject(
        'Receipt does not contain one exact intended token transfer.',
      );
    const currentBlock = await this.publicClient.getBlockNumber();
    const confirmations =
      currentBlock >= receipt.blockNumber
        ? Number(currentBlock - receipt.blockNumber + 1n)
        : 0;
    if (confirmations < circle.receiptConfirmations) {
      throw new CircleReceiptVerificationError(
        'Circle transaction receipt needs more selected-network confirmations.',
        true,
      );
    }
  }

  private reject(message: string): never {
    throw new CircleReceiptVerificationError(message, false);
  }
}
