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
  encodeAbiParameters,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  parseAbiItem,
  parseAbiParameters,
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
const MAINNET_PAYMENT_EVENT = parseAbiItem(
  'event DirectUsdcPayment(bytes32 indexed referenceHash, address indexed payer, address indexed recipient, uint256 paymentIndex, uint256 grossAmount, uint256 netAmount, uint256 feeAmount)',
);
const MAINNET_REFERENCE_EVENT = parseAbiItem(
  'event PayrollReferenceConsumed(bytes32 indexed referenceHash, address indexed payer, address indexed token, bytes32 batchDigest, uint256 totalAmount, uint256 totalOut, uint256 totalFees, uint256 recipientCount, string referenceId)',
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
      callMinimums,
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
    if (this.network.key === 'arc-mainnet') {
      if (
        !verifyMainnetReceiptEvidence({
          logs: receipt.logs,
          chainId: this.network.chainId,
          contract: contractAddress,
          payer: sourceWallet,
          token,
          referenceId: input.referenceId,
          recipients: callRecipients.map((recipient) => getAddress(recipient)),
          amounts: [...callAmounts],
          minimums: [...callMinimums],
        })
      )
        this.reject();
      return true;
    }
    const batchMatches = receipt.logs.filter((log) => {
      if (!isAddressEqual(log.address, contractAddress)) return false;
      try {
        const decoded = decodeEventLog({
          abi: [BATCH_EVENT],
          data: log.data,
          topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
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
          topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
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

function verifyMainnetReceiptEvidence(input: {
  logs: readonly {
    address: `0x${string}`;
    data: `0x${string}`;
    topics: readonly `0x${string}`[];
  }[];
  chainId: number;
  contract: `0x${string}`;
  payer: `0x${string}`;
  token: `0x${string}`;
  referenceId: string;
  recipients: readonly `0x${string}`[];
  amounts: readonly bigint[];
  minimums: readonly bigint[];
}) {
  const referenceHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters('uint256, address, address, address, string'),
      [
        BigInt(input.chainId),
        input.contract,
        input.payer,
        input.token,
        input.referenceId,
      ],
    ),
  );
  const batchDigest = keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'uint256, address, address, address, address[], uint256[]',
      ),
      [
        BigInt(input.chainId),
        input.contract,
        input.payer,
        input.token,
        input.recipients,
        input.amounts,
      ],
    ),
  );
  const payments = new Map<number, { net: bigint; fee: bigint }>();
  let summaryCount = 0;
  let summaryOut = 0n;
  let summaryFees = 0n;
  let incoming = 0n;
  let outgoing = 0n;
  for (const log of input.logs) {
    if (isAddressEqual(log.address, input.contract)) {
      try {
        const decoded = decodeEventLog({
          abi: [MAINNET_PAYMENT_EVENT],
          data: log.data,
          topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
        });
        const index = Number(decoded.args.paymentIndex);
        if (
          decoded.eventName !== 'DirectUsdcPayment' ||
          decoded.args.referenceHash !== referenceHash ||
          !isAddressEqual(decoded.args.payer, input.payer) ||
          index >= input.recipients.length ||
          payments.has(index) ||
          !isAddressEqual(decoded.args.recipient, input.recipients[index]) ||
          decoded.args.grossAmount !== input.amounts[index] ||
          decoded.args.netAmount + decoded.args.feeAmount !==
            decoded.args.grossAmount ||
          decoded.args.netAmount < input.minimums[index]
        )
          return false;
        payments.set(index, {
          net: decoded.args.netAmount,
          fee: decoded.args.feeAmount,
        });
        continue;
      } catch {
        // Try the summary event next.
      }
      try {
        const decoded = decodeEventLog({
          abi: [MAINNET_REFERENCE_EVENT],
          data: log.data,
          topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
        });
        const totalAmount = input.amounts.reduce(
          (sum, amount) => sum + amount,
          0n,
        );
        if (
          decoded.eventName !== 'PayrollReferenceConsumed' ||
          decoded.args.referenceHash !== referenceHash ||
          !isAddressEqual(decoded.args.payer, input.payer) ||
          !isAddressEqual(decoded.args.token, input.token) ||
          decoded.args.batchDigest !== batchDigest ||
          decoded.args.totalAmount !== totalAmount ||
          decoded.args.recipientCount !== BigInt(input.recipients.length) ||
          decoded.args.referenceId !== input.referenceId
        )
          return false;
        summaryCount += 1;
        summaryOut = decoded.args.totalOut;
        summaryFees = decoded.args.totalFees;
      } catch {
        // Ignore the legacy compatibility event and unrelated contract logs.
      }
    }
    if (!isAddressEqual(log.address, input.token)) continue;
    try {
      const decoded = decodeEventLog({
        abi: [TRANSFER_EVENT],
        data: log.data,
        topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.eventName !== 'Transfer') continue;
      if (
        isAddressEqual(decoded.args.from, input.payer) &&
        isAddressEqual(decoded.args.to, input.contract)
      )
        incoming += decoded.args.value;
      if (isAddressEqual(decoded.args.from, input.contract))
        outgoing += decoded.args.value;
    } catch {
      // Ignore unrelated canonical-token logs.
    }
  }
  const totalAmount = input.amounts.reduce((sum, amount) => sum + amount, 0n);
  const paymentOut = [...payments.values()].reduce(
    (sum, payment) => sum + payment.net,
    0n,
  );
  const paymentFees = [...payments.values()].reduce(
    (sum, payment) => sum + payment.fee,
    0n,
  );
  return (
    payments.size === input.recipients.length &&
    summaryCount === 1 &&
    incoming === totalAmount &&
    outgoing === totalAmount &&
    paymentOut === summaryOut &&
    paymentFees === summaryFees &&
    summaryOut + summaryFees === totalAmount
  );
}
