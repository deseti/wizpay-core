import {
  Injectable,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  decodeFunctionData,
  decodeEventLog,
  getAddress,
  http,
  isAddressEqual,
  parseAbiItem,
  type Hash,
  type PublicClient,
} from 'viem';
import type { BackendArcNetworkConfiguration } from '../config/arc-network.config';

const BATCH_EVENT = parseAbiItem(
  'event BatchPaymentRouted(address indexed sender, address tokenIn, address tokenOut, uint256 totalAmountIn, uint256 totalAmountOut, uint256 totalFees, uint256 recipientCount, string referenceId)',
);
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const PAYROLL_ABI = [
  {
    type: 'function',
    name: 'batchRouteAndPay',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOuts', type: 'address[]' },
      { name: 'recipients', type: 'address[]' },
      { name: 'amountsIn', type: 'uint256[]' },
      { name: 'minAmountsOut', type: 'uint256[]' },
      { name: 'referenceId', type: 'string' },
    ],
    outputs: [{ name: 'totalOut', type: 'uint256' }],
  },
] as const;

@Injectable()
export class PayrollReceiptVerifierService {
  private readonly network: BackendArcNetworkConfiguration;
  private readonly client: PublicClient;
  private readonly confirmationsRequired: number;

  constructor(config: ConfigService) {
    this.network =
      config.getOrThrow<BackendArcNetworkConfiguration>('arcNetwork');
    this.client = createPublicClient({
      chain: {
        id: this.network.chainId,
        name: this.network.key,
        nativeCurrency: { decimals: 18, name: 'USDC', symbol: 'USDC' },
        rpcUrls: { default: { http: [this.network.rpcUrl] } },
      },
      transport: http(this.network.rpcUrl, { retryCount: 1, timeout: 10_000 }),
    });
    const configured = Number(
      config.get('INVOICE_CONFIRMATIONS_REQUIRED') ?? 1,
    );
    this.confirmationsRequired =
      Number.isInteger(configured) && configured > 0 ? configured : 1;
  }

  async verify(input: {
    transactionHash: string;
    sourceWallet: string;
    token: string;
    totalAmountUnits: string;
    referenceId: string;
    recipients: readonly { address: string; amountUnits: string }[];
  }) {
    const contract = this.network.contracts.wizpay?.address;
    if (!contract)
      throw new ServiceUnavailableException({
        code: 'PAYROLL_CONTRACT_UNAVAILABLE',
        message: 'Verified payroll contract is unavailable.',
      });
    let transaction;
    let receipt;
    try {
      const hash = input.transactionHash as Hash;
      if ((await this.client.getChainId()) !== this.network.chainId)
        this.reject();
      [transaction, receipt] = await Promise.all([
        this.client.getTransaction({ hash }),
        this.client.getTransactionReceipt({ hash }),
      ]);
    } catch (error) {
      if (error instanceof UnprocessableEntityException) throw error;
      throw new ServiceUnavailableException({
        code: 'PAYROLL_RECEIPT_PENDING',
        message: 'Payroll receipt is not available yet.',
        retryable: true,
      });
    }
    if (
      receipt.status !== 'success' ||
      transaction.chainId !== this.network.chainId ||
      transaction.value !== 0n
    )
      this.reject();
    const sourceWallet = getAddress(input.sourceWallet);
    const token = getAddress(input.token);
    const contractAddress = getAddress(contract);
    if (
      !transaction.to ||
      !isAddressEqual(getAddress(transaction.to), contractAddress) ||
      !isAddressEqual(getAddress(transaction.from), sourceWallet)
    )
      this.reject();
    let decodedCall;
    try {
      decodedCall = decodeFunctionData({
        abi: PAYROLL_ABI,
        data: transaction.input,
      });
    } catch {
      this.reject();
    }
    if (decodedCall.functionName !== 'batchRouteAndPay') this.reject();
    const [
      callTokenIn,
      callTokenOuts,
      callRecipients,
      callAmounts,
      ,
      callReference,
    ] = decodedCall.args;
    if (
      !isAddressEqual(getAddress(callTokenIn), token) ||
      callTokenOuts.length !== input.recipients.length ||
      callTokenOuts.some(
        (candidate) => !isAddressEqual(getAddress(candidate), token),
      ) ||
      callReference !== input.referenceId ||
      callRecipients.length !== input.recipients.length ||
      callAmounts.length !== input.recipients.length ||
      callRecipients.some(
        (recipient, index) =>
          !isAddressEqual(
            getAddress(recipient),
            getAddress(input.recipients[index].address),
          ) ||
          callAmounts[index] !== BigInt(input.recipients[index].amountUnits),
      )
    )
      this.reject();
    let latestBlock: bigint;
    try {
      latestBlock = await this.client.getBlockNumber();
    } catch {
      throw new ServiceUnavailableException({
        code: 'PAYROLL_RECEIPT_PENDING',
        message: 'Payroll confirmation state is not available yet.',
        retryable: true,
      });
    }
    const confirmations = Number(latestBlock - receipt.blockNumber + 1n);
    if (confirmations < this.confirmationsRequired)
      throw new ServiceUnavailableException({
        code: 'PAYROLL_CONFIRMATIONS_PENDING',
        message: `Payroll receipt needs ${this.confirmationsRequired} confirmations.`,
        retryable: true,
      });
    const batchMatches = receipt.logs.filter((log) => {
      if (!isAddressEqual(log.address, contractAddress)) return false;
      try {
        const decoded = decodeEventLog({
          abi: [BATCH_EVENT],
          data: log.data,
          topics: log.topics,
        });
        return (
          decoded.eventName === 'BatchPaymentRouted' &&
          isAddressEqual(getAddress(decoded.args.sender), sourceWallet) &&
          isAddressEqual(getAddress(decoded.args.tokenIn), token) &&
          isAddressEqual(getAddress(decoded.args.tokenOut), token) &&
          decoded.args.totalAmountIn === BigInt(input.totalAmountUnits) &&
          decoded.args.recipientCount === BigInt(input.recipients.length) &&
          decoded.args.referenceId === input.referenceId
        );
      } catch {
        return false;
      }
    });
    if (batchMatches.length !== 1) this.reject();
    const paidAmounts = new Map<string, bigint>();
    for (const log of receipt.logs) {
      if (!isAddressEqual(log.address, token)) continue;
      try {
        const decoded = decodeEventLog({
          abi: [TRANSFER_EVENT],
          data: log.data,
          topics: log.topics,
        });
        if (
          decoded.eventName === 'Transfer' &&
          isAddressEqual(getAddress(decoded.args.from), contractAddress)
        ) {
          const recipient = getAddress(decoded.args.to).toLowerCase();
          paidAmounts.set(
            recipient,
            (paidAmounts.get(recipient) ?? 0n) + decoded.args.value,
          );
        }
      } catch {
        // Ignore unrelated token logs; the exact aggregate is checked below.
      }
    }
    const expectedAmounts = new Map<string, bigint>();
    for (const recipient of input.recipients) {
      const address = getAddress(recipient.address).toLowerCase();
      expectedAmounts.set(
        address,
        (expectedAmounts.get(address) ?? 0n) + BigInt(recipient.amountUnits),
      );
    }
    if (
      paidAmounts.size !== expectedAmounts.size ||
      [...expectedAmounts].some(
        ([recipient, amount]) => paidAmounts.get(recipient) !== amount,
      )
    )
      this.reject();
    return true;
  }

  private reject(): never {
    throw new UnprocessableEntityException({
      code: 'PAYROLL_RECEIPT_MISMATCH',
      message: 'Payroll receipt does not match the immutable direct batch.',
      retryable: false,
    });
  }
}
