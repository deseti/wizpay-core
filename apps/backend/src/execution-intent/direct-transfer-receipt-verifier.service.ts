import {
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  http,
  isAddressEqual,
  parseAbiItem,
  type Hash,
  type PublicClient,
} from 'viem';
import type { BackendArcNetworkConfiguration } from '../config/arc-network.config';

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'recipient', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

@Injectable()
export class DirectTransferReceiptVerifierService {
  private readonly network: BackendArcNetworkConfiguration;
  private readonly publicClient: PublicClient;
  private readonly confirmationsRequired: number;

  constructor(config: ConfigService) {
    this.network =
      config.getOrThrow<BackendArcNetworkConfiguration>('arcNetwork');
    this.publicClient = createPublicClient({
      chain: {
        id: this.network.chainId,
        name: this.network.key,
        nativeCurrency: { decimals: 18, name: 'USDC', symbol: 'USDC' },
        rpcUrls: { default: { http: [this.network.rpcUrl] } },
      },
      transport: http(this.network.rpcUrl, { retryCount: 1, timeout: 10_000 }),
    });
    const configured = Number(
      config.get('EXECUTION_INTENT_CONFIRMATIONS_REQUIRED') ??
        config.get('INVOICE_CONFIRMATIONS_REQUIRED') ??
        1,
    );
    this.confirmationsRequired =
      Number.isInteger(configured) && configured > 0 ? configured : 1;
  }

  async verify(input: {
    transactionHash: string;
    sender: string;
    recipient: string;
    token: string;
    amountUnits: string;
  }) {
    const hash = input.transactionHash as Hash;
    let providerChainId: number;
    let transaction: Awaited<ReturnType<PublicClient['getTransaction']>>;
    let receipt: Awaited<ReturnType<PublicClient['getTransactionReceipt']>>;
    try {
      providerChainId = await this.publicClient.getChainId();
      [transaction, receipt] = await Promise.all([
        this.publicClient.getTransaction({ hash }),
        this.publicClient.getTransactionReceipt({ hash }),
      ]);
    } catch {
      throw new ServiceUnavailableException({
        code: 'EXECUTION_INTENT_RECEIPT_PENDING',
        message: 'The selected Arc receipt is not available yet.',
        retryable: true,
      });
    }
    if (providerChainId !== this.network.chainId)
      this.reject('Receipt provider is connected to the wrong Arc network.');
    if (
      transaction.hash.toLowerCase() !== hash.toLowerCase() ||
      receipt.transactionHash.toLowerCase() !== hash.toLowerCase()
    )
      this.reject('The returned transaction hash does not match the intent.');
    if (receipt.status !== 'success')
      this.reject('The transaction receipt failed.');
    if (transaction.chainId !== this.network.chainId)
      this.reject('The transaction was submitted on the wrong Arc network.');
    if (transaction.value !== 0n)
      this.reject('The token transfer unexpectedly included native value.');

    const sender = getAddress(input.sender);
    const recipient = getAddress(input.recipient);
    const token = getAddress(input.token);
    const amount = BigInt(input.amountUnits);
    if (
      !transaction.to ||
      !isAddressEqual(getAddress(transaction.to), token) ||
      !isAddressEqual(getAddress(transaction.from), sender)
    )
      this.reject('Transaction target or sender does not match the intent.');
    try {
      const decoded = decodeFunctionData({
        abi: TRANSFER_ABI,
        data: transaction.input,
      });
      if (
        decoded.functionName !== 'transfer' ||
        !isAddressEqual(decoded.args[0], recipient) ||
        decoded.args[1] !== amount
      )
        this.reject('Transaction calldata does not match the intent.');
    } catch {
      this.reject('Transaction calldata does not match the intent.');
    }
    const matches = receipt.logs.filter((log) => {
      if (!isAddressEqual(log.address, token)) return false;
      try {
        const decoded = decodeEventLog({
          abi: [TRANSFER_EVENT],
          data: log.data,
          topics: log.topics,
        });
        return (
          decoded.eventName === 'Transfer' &&
          isAddressEqual(getAddress(decoded.args.from), sender) &&
          isAddressEqual(getAddress(decoded.args.to), recipient) &&
          decoded.args.value === amount
        );
      } catch {
        return false;
      }
    });
    if (matches.length !== 1)
      this.reject(
        'Receipt does not contain one exact intended token transfer.',
      );
    let currentBlock: bigint;
    try {
      currentBlock = await this.publicClient.getBlockNumber();
    } catch {
      throw new ServiceUnavailableException({
        code: 'EXECUTION_INTENT_RECEIPT_PENDING',
        message: 'The selected Arc confirmation state is not available yet.',
        retryable: true,
      });
    }
    const confirmations =
      currentBlock >= receipt.blockNumber
        ? Number(currentBlock - receipt.blockNumber + 1n)
        : 0;
    if (confirmations < this.confirmationsRequired)
      throw new ServiceUnavailableException({
        code: 'EXECUTION_INTENT_RECEIPT_PENDING',
        message: `The selected Arc receipt needs ${this.confirmationsRequired} confirmations.`,
        retryable: true,
      });
    return {
      network: this.network.key,
      transactionHash: hash,
      sourceWallet: sender,
      recipient,
      token,
      amountUnits: amount.toString(),
    };
  }

  private reject(message: string): never {
    throw new UnprocessableEntityException({
      code: 'EXECUTION_INTENT_RECEIPT_MISMATCH',
      message,
      retryable: false,
    });
  }
}
