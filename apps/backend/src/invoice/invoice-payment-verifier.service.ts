import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  isAddressEqual,
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

const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ARC_NATIVE_ACCOUNTING_MIRROR = getAddress(
  '0xfffffffffffffffffffffffffffffffffffffffe',
);

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
  private readonly logger = new Logger(InvoicePaymentVerifierService.name);
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
    const requestId = randomUUID();
    const verificationRef = this.stableIdentifier(input.transactionHash);
    const startedAt = Date.now();
    let stage = 'configured_chain';
    let canonicalLogCount = 0;
    let tokenLogCount = 0;
    try {
      const configuredChainId = await this.publicClient.getChainId();
      if (configuredChainId !== INVOICE_CHAIN_ID) {
        this.reject(
          INVOICE_ERROR_CODES.WRONG_CHAIN,
          'The verification provider is not connected to Arc Testnet.',
        );
      }

      stage = 'transaction_receipt';
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
      if (transaction.value !== 0n)
        this.reject(
          INVOICE_ERROR_CODES.NATIVE_VALUE,
          'The token payment transaction must not include native value.',
        );
      stage = 'transfer_log_filter';
      const canonicalLogs = receipt.logs.filter(
        (log) =>
          !isAddressEqual(log.address, ARC_NATIVE_ACCOUNTING_MIRROR) &&
          log.topics[0]?.toLowerCase() === TRANSFER_TOPIC,
      );
      canonicalLogCount = canonicalLogs.length;
      const tokenLogs = canonicalLogs.filter((log) =>
        isAddressEqual(log.address, input.tokenAddress),
      );
      tokenLogCount = tokenLogs.length;
      if (tokenLogs.length === 0) {
        this.reject(
          canonicalLogs.length > 0
            ? INVOICE_ERROR_CODES.WRONG_TOKEN
            : INVOICE_ERROR_CODES.TRANSFER_EVENT_MISSING,
          canonicalLogs.length > 0
            ? 'The canonical Transfer event was emitted by the wrong token contract.'
            : 'The receipt is missing a canonical ERC-20 Transfer event.',
        );
      }

      const decodedTransfers = tokenLogs.flatMap((log, logIndex) => {
        try {
          const decoded = decodeEventLog({
            abi: [TRANSFER_EVENT],
            data: log.data,
            topics: log.topics,
          });
          if (decoded.eventName !== 'Transfer') return [];
          return [
            {
              amount: decoded.args.value,
              logIndex,
              payerAddress: getAddress(decoded.args.from),
              recipientAddress: getAddress(decoded.args.to),
            },
          ];
        } catch {
          return [];
        }
      });
      if (decodedTransfers.length === 0)
        this.reject(
          INVOICE_ERROR_CODES.TRANSFER_EVENT_MISSING,
          'The invoice token logs do not contain a valid canonical Transfer event.',
        );
      const recipientMatches = decodedTransfers.filter((transfer) =>
        isAddressEqual(transfer.recipientAddress, input.merchantWalletAddress),
      );
      if (recipientMatches.length === 0)
        this.reject(
          INVOICE_ERROR_CODES.WRONG_RECIPIENT,
          'The transfer recipient does not match this invoice.',
        );
      const amountMatches = recipientMatches.filter(
        (transfer) => transfer.amount === BigInt(input.amountUnits),
      );
      if (amountMatches.length === 0)
        this.reject(
          INVOICE_ERROR_CODES.WRONG_AMOUNT,
          'The transfer amount does not exactly match this invoice.',
        );
      const externalMatches = amountMatches.filter(
        (transfer) =>
          !isAddressEqual(transfer.payerAddress, input.merchantWalletAddress),
      );
      if (externalMatches.length === 0)
        this.reject(
          INVOICE_ERROR_CODES.SELF_PAYMENT,
          "This invoice cannot be paid from the merchant's receiving wallet.",
        );
      if (externalMatches.length !== 1)
        this.reject(
          INVOICE_ERROR_CODES.TRANSFER_EVENT_MISSING,
          'The receipt contains multiple matching invoice transfers and cannot be accepted unambiguously.',
        );
      const matchedTransfer = externalMatches[0];

      stage = 'confirmations';
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
      const verified = {
        blockNumber: receipt.blockNumber,
        confirmations: confirmationCount,
        payerAddress: matchedTransfer.payerAddress,
        transactionHash: input.transactionHash,
      };
      this.logger.log(
        `Invoice verification requestId=${requestId} verificationRef=${verificationRef} stage=transfer_log_match outcome=verified canonicalLogs=${canonicalLogCount} tokenLogs=${tokenLogCount} logIndex=${matchedTransfer.logIndex} payerRef=${this.stableIdentifier(matchedTransfer.payerAddress)} confirmations=${confirmationCount} durationMs=${Date.now() - startedAt}`,
      );
      return verified;
    } catch (error) {
      if (error instanceof InvoiceVerificationError) {
        this.logger.warn(
          `Invoice verification requestId=${requestId} verificationRef=${verificationRef} stage=${stage} outcome=${error.retryable ? 'retry' : 'rejected'} code=${error.code} canonicalLogs=${canonicalLogCount} tokenLogs=${tokenLogCount} durationMs=${Date.now() - startedAt}`,
        );
        throw error;
      }
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

  private stableIdentifier(value: string): string {
    return createHash('sha256')
      .update(value.toLowerCase())
      .digest('hex')
      .slice(0, 12);
  }
}
