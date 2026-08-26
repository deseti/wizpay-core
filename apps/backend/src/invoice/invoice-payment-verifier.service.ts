import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  http,
  isAddress,
  isAddressEqual,
  parseAbi,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { resolveArcTestnetRpcUrl } from '../config/arc-rpc';
import {
  INVOICE_CHAIN_ID,
  INVOICE_ERROR_CODES,
  InvoiceVerificationError,
  type InvoiceVerificationCode,
} from './invoice.types';

const ERC20_TRANSFER_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
]);
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const TRANSFER_SELECTOR = '0xa9059cbb';
const EXACT_TRANSFER_CALLDATA_HEX_LENGTH = 2 + 8 + 64 + 64;

export type VerifyInvoiceTransferInput = {
  amountUnits: string;
  merchantWalletAddress: Address;
  tokenAddress: Address;
  transactionHash: Hex;
};

export type VerifiedInvoiceTransfer = {
  blockNumber: bigint;
  confirmations: number;
  payerAddress: Address;
  transactionHash: Hex;
};

@Injectable()
export class InvoicePaymentVerifierService {
  private readonly confirmationsRequired: number;
  private publicClient: PublicClient;

  constructor(config: ConfigService) {
    const configuredConfirmations = Number(
      config.get<string>('INVOICE_PAYMENT_CONFIRMATIONS') || '2',
    );
    if (
      !Number.isInteger(configuredConfirmations) ||
      configuredConfirmations < 1 ||
      configuredConfirmations > 100
    ) {
      throw new Error(
        'INVOICE_PAYMENT_CONFIRMATIONS must be an integer from 1 to 100.',
      );
    }
    this.confirmationsRequired = configuredConfirmations;
    const rpcUrl = resolveArcTestnetRpcUrl([
      {
        name: 'ARC_TESTNET_RPC_URL',
        value: config.get<string>('ARC_TESTNET_RPC_URL'),
      },
      { name: 'RPC_URL', value: config.get<string>('RPC_URL') },
      {
        name: 'NEXT_PUBLIC_ARC_TESTNET_RPC_URL',
        value: config.get<string>('NEXT_PUBLIC_ARC_TESTNET_RPC_URL'),
      },
    ]);
    this.publicClient = createPublicClient({
      chain: {
        id: INVOICE_CHAIN_ID,
        name: 'Arc Testnet',
        nativeCurrency: { decimals: 18, name: 'USDC', symbol: 'USDC' },
        rpcUrls: { default: { http: [rpcUrl] } },
      },
      transport: http(rpcUrl, { retryCount: 1, timeout: 10_000 }),
    });
  }

  async verify(
    input: VerifyInvoiceTransferInput,
  ): Promise<VerifiedInvoiceTransfer> {
    try {
      const configuredChainId = await this.publicClient.getChainId();
      if (configuredChainId !== INVOICE_CHAIN_ID) {
        this.reject(
          INVOICE_ERROR_CODES.WRONG_CHAIN,
          'The verification provider is not connected to Arc Testnet.',
        );
      }

      const [transaction, receipt] = await Promise.all([
        this.publicClient.getTransaction({ hash: input.transactionHash }),
        this.publicClient.getTransactionReceipt({
          hash: input.transactionHash,
        }),
      ]);
      if (!transaction)
        this.retry(
          INVOICE_ERROR_CODES.TRANSACTION_PENDING,
          'The transaction is not available on Arc Testnet yet.',
        );
      if (!receipt)
        this.retry(
          INVOICE_ERROR_CODES.RECEIPT_PENDING,
          'The transaction receipt is not available yet.',
        );
      if (receipt.status !== 'success')
        this.reject(
          INVOICE_ERROR_CODES.FAILED_RECEIPT,
          'The payment transaction reverted.',
        );
      if (transaction.chainId !== INVOICE_CHAIN_ID)
        this.reject(
          INVOICE_ERROR_CODES.WRONG_CHAIN,
          'The transaction is not an Arc Testnet transaction.',
        );
      if (!isAddress(transaction.from))
        this.reject(
          INVOICE_ERROR_CODES.WRONG_SENDER,
          'The transaction sender is invalid.',
        );
      const payerAddress = getAddress(transaction.from);
      if (isAddressEqual(payerAddress, input.merchantWalletAddress)) {
        this.reject(
          INVOICE_ERROR_CODES.SELF_PAYMENT,
          "This invoice cannot be paid from the merchant's receiving wallet.",
        );
      }
      if (
        !transaction.to ||
        !isAddress(transaction.to) ||
        !isAddressEqual(getAddress(transaction.to), input.tokenAddress)
      ) {
        this.reject(
          INVOICE_ERROR_CODES.WRONG_TOKEN,
          'The transaction does not call the invoice token contract.',
        );
      }
      if (transaction.value !== 0n)
        this.reject(
          INVOICE_ERROR_CODES.NATIVE_VALUE,
          'The token payment transaction must not include native value.',
        );
      if (
        transaction.input.length !== EXACT_TRANSFER_CALLDATA_HEX_LENGTH ||
        transaction.input.slice(0, 10).toLowerCase() !== TRANSFER_SELECTOR
      ) {
        this.reject(
          INVOICE_ERROR_CODES.MALFORMED_CALLDATA,
          'The transaction is not one exact ERC-20 transfer call.',
        );
      }

      let recipient: Address;
      let amount: bigint;
      try {
        const decoded = decodeFunctionData({
          abi: ERC20_TRANSFER_ABI,
          data: transaction.input,
        });
        if (decoded.functionName !== 'transfer' || decoded.args.length !== 2)
          throw new Error('not transfer');
        recipient = getAddress(decoded.args[0]);
        amount = decoded.args[1];
      } catch {
        this.reject(
          INVOICE_ERROR_CODES.MALFORMED_CALLDATA,
          'The ERC-20 transfer calldata is malformed.',
        );
      }
      if (!isAddressEqual(recipient!, input.merchantWalletAddress)) {
        this.reject(
          INVOICE_ERROR_CODES.WRONG_RECIPIENT,
          'The transfer recipient does not match this invoice.',
        );
      }
      if (amount! !== BigInt(input.amountUnits)) {
        this.reject(
          INVOICE_ERROR_CODES.WRONG_AMOUNT,
          'The transfer amount does not exactly match this invoice.',
        );
      }

      const matchingEvent = receipt.logs.some((log) => {
        if (!isAddressEqual(log.address, input.tokenAddress)) return false;
        try {
          const decoded = decodeEventLog({
            abi: [TRANSFER_EVENT],
            data: log.data,
            topics: log.topics,
          });
          return (
            decoded.eventName === 'Transfer' &&
            isAddressEqual(decoded.args.from, payerAddress) &&
            isAddressEqual(decoded.args.to, input.merchantWalletAddress) &&
            decoded.args.value === BigInt(input.amountUnits)
          );
        } catch {
          return false;
        }
      });
      if (!matchingEvent)
        this.reject(
          INVOICE_ERROR_CODES.TRANSFER_EVENT_MISSING,
          'The receipt is missing the exact canonical Transfer event.',
        );

      const currentBlock = await this.publicClient.getBlockNumber();
      const confirmationCount =
        currentBlock >= receipt.blockNumber
          ? Number(currentBlock - receipt.blockNumber + 1n)
          : 0;
      if (confirmationCount < this.confirmationsRequired) {
        this.retry(
          INVOICE_ERROR_CODES.CONFIRMATIONS_PENDING,
          `Payment needs ${this.confirmationsRequired} Arc Testnet confirmations.`,
        );
      }
      return {
        blockNumber: receipt.blockNumber,
        confirmations: confirmationCount,
        payerAddress,
        transactionHash: input.transactionHash,
      };
    } catch (error) {
      if (error instanceof InvoiceVerificationError) throw error;
      const name = error instanceof Error ? error.name : '';
      if (/TransactionReceiptNotFound/i.test(name))
        this.retry(
          INVOICE_ERROR_CODES.RECEIPT_PENDING,
          'The transaction receipt is not available yet.',
        );
      if (/TransactionNotFound/i.test(name))
        this.retry(
          INVOICE_ERROR_CODES.TRANSACTION_PENDING,
          'The transaction is not available on Arc Testnet yet.',
        );
      this.retry(
        INVOICE_ERROR_CODES.RPC_UNAVAILABLE,
        'Arc Testnet verification is temporarily unavailable. Retry this same transaction hash.',
      );
    }
  }

  private retry(code: InvoiceVerificationCode, message: string): never {
    throw new InvoiceVerificationError(code, message, true);
  }

  private reject(code: InvoiceVerificationCode, message: string): never {
    throw new InvoiceVerificationError(code, message, false);
  }
}
