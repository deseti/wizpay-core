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
  type Transaction,
  type TransactionReceipt,
} from 'viem';
import type { BackendArcNetworkConfiguration } from '../config/arc-network.config';
import { WIZPAY_PAYROLL_MAINNET_ABI } from '../contracts/generated/wizpay-payroll-mainnet.abi';
import { createPayrollBatchDigest } from '../execution-intent/execution-intent.service';
import type { VerifiedExecutionReceipt } from '../execution-intent/execution-intent.service';

export type VerifiedPayrollReceipt = VerifiedExecutionReceipt &
  Readonly<{
    contract: `0x${string}`;
    referenceId: string;
    recipients: readonly Readonly<{
      address: `0x${string}`;
      amountUnits: string;
    }>[];
    blockNumber: string;
    confirmations: number;
  }>;

const BATCH_EVENT = parseAbiItem(
  'event BatchPaymentRouted(address indexed sender, address tokenIn, address tokenOut, uint256 totalAmountIn, uint256 totalAmountOut, uint256 totalFees, uint256 recipientCount, string referenceId)',
);
const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const MAINNET_PAYMENT_EVENT = parseAbiItem(
  'event PayrollPayment(bytes32 indexed referenceHash, address indexed employer, address indexed tokenOut, address recipient, uint256 paymentIndex, uint256 amountOut)',
);
const MAINNET_REFERENCE_EVENT = parseAbiItem(
  'event PayrollReferenceConsumed(bytes32 indexed referenceHash, address indexed employer, address indexed tokenIn, address tokenOut, bytes32 batchDigest, uint256 totalInput, uint256 totalOutput, uint256 totalFees, uint256 recipientCount, string referenceId)',
);
const MAINNET_BATCH_EVENT = parseAbiItem(
  'event PayrollBatchExecuted(address indexed employer, address indexed tokenIn, address indexed tokenOut, uint256 totalInput, uint256 totalOutput, uint256 totalFees, uint256 recipientCount, string referenceId)',
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
    expectedBatchDigest: string;
    referenceId: string;
    recipients: readonly { address: string; amountUnits: string }[];
  }): Promise<VerifiedPayrollReceipt> {
    const contract = this.network.contracts.wizpay?.address;
    if (!contract)
      throw new ServiceUnavailableException({
        code: 'PAYROLL_CONTRACT_UNAVAILABLE',
        message: 'Verified payroll contract is unavailable.',
      });
    if (!isTransactionHash(input.transactionHash)) this.reject();
    if (
      !input.referenceId.trim() ||
      input.recipients.length === 0 ||
      !isCanonicalUint(input.totalAmountUnits) ||
      !/^[0-9a-fA-F]{64}$/.test(input.expectedBatchDigest) ||
      input.recipients.some(
        (recipient) =>
          !isCanonicalUint(recipient.amountUnits) ||
          recipient.amountUnits === '0',
      )
    )
      this.reject();
    let sourceWallet: `0x${string}`;
    let token: `0x${string}`;
    let contractAddress: `0x${string}`;
    try {
      sourceWallet = getAddress(input.sourceWallet);
      token = getAddress(input.token);
      contractAddress = getAddress(contract);
      for (const recipient of input.recipients) getAddress(recipient.address);
    } catch {
      this.reject();
    }
    let transaction: Transaction;
    let receipt: TransactionReceipt;
    try {
      const hash: Hash = input.transactionHash;
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
      transaction.hash.toLowerCase() !== input.transactionHash.toLowerCase() ||
      receipt.transactionHash.toLowerCase() !==
        input.transactionHash.toLowerCase() ||
      transaction.chainId !== this.network.chainId
    )
      this.reject();
    if (
      !transaction.to ||
      !isAddressEqual(getAddress(transaction.to), contractAddress) ||
      !isAddressEqual(getAddress(transaction.from), sourceWallet)
    )
      this.reject();
    let decodedCall: ReturnType<typeof decodeFunctionData>;
    try {
      decodedCall = decodeFunctionData({
        abi:
          this.network.key === 'arc-mainnet'
            ? WIZPAY_PAYROLL_MAINNET_ABI
            : PAYROLL_ABI,
        data: transaction.input,
      });
    } catch {
      this.reject();
    }
    if (this.network.key === 'arc-mainnet') {
      const verified = this.verifyMainnetCall(
        decodedCall,
        transaction.value,
        sourceWallet,
        token,
        input,
      );
      return this.finishMainnetReceipt({
        transaction,
        receipt,
        contractAddress,
        sourceWallet,
        token: verified.tokenOut,
        input,
        verified,
      });
    }
    if (transaction.value !== 0n) this.reject();
    if (!isPayrollBatchCall(decodedCall)) this.reject();
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
    const verifiedRecipients = callRecipients.map((recipient, index) => ({
      address: getAddress(recipient),
      amountUnits: callAmounts[index].toString(),
    }));
    const verifiedTotal = callAmounts.reduce((sum, amount) => sum + amount, 0n);
    const verifiedBatchDigest = createPayrollBatchDigest(
      verifiedRecipients.map((recipient) => ({
        recipient: recipient.address,
        token,
        amountUnits: recipient.amountUnits,
      })),
    );
    if (
      verifiedTotal.toString() !== input.totalAmountUnits ||
      verifiedBatchDigest !== input.expectedBatchDigest.toLowerCase()
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
    if (latestBlock < receipt.blockNumber) this.reject();
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
    return this.evidence({
      transactionHash: transaction.hash,
      sourceWallet,
      token,
      contractAddress,
      referenceId: input.referenceId,
      recipients: verifiedRecipients,
      batchDigest: verifiedBatchDigest,
      totalAmountUnits: verifiedTotal.toString(),
      blockNumber: receipt.blockNumber,
      confirmations,
    });
  }

  private verifyMainnetCall(
    decodedCall: ReturnType<typeof decodeFunctionData>,
    value: bigint,
    sourceWallet: `0x${string}`,
    token: `0x${string}`,
    input: {
      referenceId: string;
      totalAmountUnits: string;
      expectedBatchDigest: string;
      recipients: readonly { address: string; amountUnits: string }[];
    },
  ) {
    if (
      decodedCall.functionName === 'executeSameTokenPayroll' &&
      decodedCall.args
    ) {
      const [callToken, callRecipients, callAmounts, callReference] =
        decodedCall.args as readonly [
          `0x${string}`,
          readonly `0x${string}`[],
          readonly bigint[],
          string,
        ];
      if (value !== 0n) this.reject();
      this.assertCallRecipients(
        callToken,
        token,
        callRecipients,
        callAmounts,
        callReference,
        input,
      );
      return {
        tokenIn: getAddress(callToken),
        tokenOut: getAddress(callToken),
        recipients: callRecipients.map((recipient) => getAddress(recipient)),
        amounts: [...callAmounts],
      };
    }
    if (
      decodedCall.functionName === 'executeCrossTokenPayroll' &&
      decodedCall.args
    ) {
      const [
        callTokenIn,
        callTokenOut,
        callRecipients,
        callAmounts,
        grossInput,
        ,
        ,
        ,
        callReference,
      ] = decodedCall.args as readonly [
        `0x${string}`,
        `0x${string}`,
        readonly `0x${string}`[],
        readonly bigint[],
        bigint,
        bigint,
        bigint,
        bigint,
        string,
      ];
      const usdc = this.network.tokens.USDC.address;
      const expectedValue = isAddressEqual(getAddress(callTokenIn), usdc)
        ? grossInput * 1_000_000_000_000n
        : 0n;
      if (value !== expectedValue) this.reject();
      this.assertCallRecipients(
        callTokenOut,
        token,
        callRecipients,
        callAmounts,
        callReference,
        input,
      );
      return {
        tokenIn: getAddress(callTokenIn),
        tokenOut: getAddress(callTokenOut),
        recipients: callRecipients.map((recipient) => getAddress(recipient)),
        amounts: [...callAmounts],
      };
    }
    this.reject();
  }

  private assertCallRecipients(
    callToken: `0x${string}`,
    expectedToken: `0x${string}`,
    callRecipients: readonly `0x${string}`[],
    callAmounts: readonly bigint[],
    callReference: string,
    input: {
      referenceId: string;
      recipients: readonly { address: string; amountUnits: string }[];
    },
  ) {
    if (
      !isAddressEqual(getAddress(callToken), expectedToken) ||
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
  }

  private async finishMainnetReceipt(input: {
    transaction: Transaction;
    receipt: TransactionReceipt;
    contractAddress: `0x${string}`;
    sourceWallet: `0x${string}`;
    token: `0x${string}`;
    verified: {
      tokenIn: `0x${string}`;
      tokenOut: `0x${string}`;
      recipients: readonly `0x${string}`[];
      amounts: readonly bigint[];
    };
    input: {
      transactionHash: string;
      referenceId: string;
      totalAmountUnits: string;
      expectedBatchDigest: string;
      recipients: readonly { address: string; amountUnits: string }[];
    };
  }): Promise<VerifiedPayrollReceipt> {
    const verifiedRecipients = input.verified.recipients.map(
      (recipient, index) => ({
        address: recipient,
        amountUnits: input.verified.amounts[index].toString(),
      }),
    );
    const verifiedTotal = input.verified.amounts.reduce(
      (sum, amount) => sum + amount,
      0n,
    );
    const verifiedBatchDigest = createPayrollBatchDigest(
      verifiedRecipients.map((recipient) => ({
        recipient: recipient.address,
        token: input.token,
        amountUnits: recipient.amountUnits,
      })),
    );
    if (
      verifiedTotal.toString() !== input.input.totalAmountUnits ||
      verifiedBatchDigest !== input.input.expectedBatchDigest.toLowerCase()
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
    if (latestBlock < input.receipt.blockNumber) this.reject();
    const confirmations = Number(latestBlock - input.receipt.blockNumber + 1n);
    if (confirmations < this.confirmationsRequired)
      throw new ServiceUnavailableException({
        code: 'PAYROLL_CONFIRMATIONS_PENDING',
        message: `Payroll receipt needs ${this.confirmationsRequired} confirmations.`,
        retryable: true,
      });
    if (
      !verifyMainnetPayrollEvents({
        logs: input.receipt.logs,
        chainId: this.network.chainId,
        contract: input.contractAddress,
        employer: input.sourceWallet,
        tokenIn: input.verified.tokenIn,
        tokenOut: input.verified.tokenOut,
        referenceId: input.input.referenceId,
        recipients: input.verified.recipients,
        amounts: input.verified.amounts,
      })
    )
      this.reject();
    return this.evidence({
      transactionHash: input.transaction.hash,
      sourceWallet: input.sourceWallet,
      token: input.token,
      contractAddress: input.contractAddress,
      referenceId: input.input.referenceId,
      recipients: verifiedRecipients,
      batchDigest: verifiedBatchDigest,
      totalAmountUnits: verifiedTotal.toString(),
      blockNumber: input.receipt.blockNumber,
      confirmations,
    });
  }

  private evidence(input: {
    transactionHash: Hash;
    sourceWallet: `0x${string}`;
    token: `0x${string}`;
    contractAddress: `0x${string}`;
    referenceId: string;
    recipients: readonly { address: `0x${string}`; amountUnits: string }[];
    batchDigest: string;
    totalAmountUnits: string;
    blockNumber: bigint;
    confirmations: number;
  }): VerifiedPayrollReceipt {
    return Object.freeze({
      network: this.network.key,
      transactionHash: input.transactionHash,
      sourceWallet: input.sourceWallet,
      token: input.token,
      batchDigest: input.batchDigest,
      amountUnits: input.totalAmountUnits,
      contract: input.contractAddress,
      referenceId: input.referenceId,
      recipients: Object.freeze(
        input.recipients.map((entry) => Object.freeze(entry)),
      ),
      blockNumber: input.blockNumber.toString(),
      confirmations: input.confirmations,
    });
  }

  private reject(): never {
    throw new UnprocessableEntityException({
      code: 'PAYROLL_RECEIPT_MISMATCH',
      message: 'Payroll receipt does not match the immutable direct batch.',
      retryable: false,
    });
  }
}

type PayrollBatchCall = {
  functionName: 'batchRouteAndPay';
  args: readonly [
    `0x${string}`,
    readonly `0x${string}`[],
    readonly `0x${string}`[],
    readonly bigint[],
    readonly bigint[],
    string,
  ];
};

function isPayrollBatchCall(
  value: ReturnType<typeof decodeFunctionData>,
): value is PayrollBatchCall {
  return (
    value.functionName === 'batchRouteAndPay' &&
    Array.isArray(value.args) &&
    value.args.length === 6
  );
}

function isCanonicalUint(value: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(value);
}

function isTransactionHash(value: string): value is Hash {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

function verifyMainnetPayrollEvents(input: {
  logs: readonly {
    address: `0x${string}`;
    data: `0x${string}`;
    topics: readonly `0x${string}`[];
  }[];
  chainId: number;
  contract: `0x${string}`;
  employer: `0x${string}`;
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  referenceId: string;
  recipients: readonly `0x${string}`[];
  amounts: readonly bigint[];
}) {
  const referenceHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters('uint256, address, address, string'),
      [
        BigInt(input.chainId),
        input.contract,
        input.employer,
        input.referenceId,
      ],
    ),
  );
  const payments = new Map<number, bigint>();
  let summaryCount = 0;
  let batchCount = 0;
  const totalOut = input.amounts.reduce((sum, amount) => sum + amount, 0n);
  for (const log of input.logs) {
    if (!isAddressEqual(log.address, input.contract)) continue;
    try {
      const decoded = decodeEventLog({
        abi: [MAINNET_PAYMENT_EVENT],
        data: log.data,
        topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
      });
      const index = Number(decoded.args.paymentIndex);
      if (
        decoded.eventName !== 'PayrollPayment' ||
        decoded.args.referenceHash !== referenceHash ||
        !isAddressEqual(decoded.args.employer, input.employer) ||
        !isAddressEqual(decoded.args.tokenOut, input.tokenOut) ||
        index >= input.recipients.length ||
        payments.has(index) ||
        !isAddressEqual(decoded.args.recipient, input.recipients[index]) ||
        decoded.args.amountOut !== input.amounts[index]
      )
        return false;
      payments.set(index, decoded.args.amountOut);
      continue;
    } catch {
      // Try summary events next.
    }
    try {
      const decoded = decodeEventLog({
        abi: [MAINNET_REFERENCE_EVENT],
        data: log.data,
        topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
      });
      if (
        decoded.eventName !== 'PayrollReferenceConsumed' ||
        decoded.args.referenceHash !== referenceHash ||
        !isAddressEqual(decoded.args.employer, input.employer) ||
        !isAddressEqual(decoded.args.tokenIn, input.tokenIn) ||
        !isAddressEqual(decoded.args.tokenOut, input.tokenOut) ||
        decoded.args.totalOutput !== totalOut ||
        decoded.args.recipientCount !== BigInt(input.recipients.length) ||
        decoded.args.referenceId !== input.referenceId
      )
        return false;
      summaryCount += 1;
      continue;
    } catch {
      // Try batch event next.
    }
    try {
      const decoded = decodeEventLog({
        abi: [MAINNET_BATCH_EVENT],
        data: log.data,
        topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
      });
      if (
        decoded.eventName !== 'PayrollBatchExecuted' ||
        !isAddressEqual(decoded.args.employer, input.employer) ||
        !isAddressEqual(decoded.args.tokenIn, input.tokenIn) ||
        !isAddressEqual(decoded.args.tokenOut, input.tokenOut) ||
        decoded.args.totalOutput !== totalOut ||
        decoded.args.recipientCount !== BigInt(input.recipients.length) ||
        decoded.args.referenceId !== input.referenceId
      )
        return false;
      batchCount += 1;
    } catch {
      // Ignore unrelated contract logs.
    }
  }
  return (
    payments.size === input.recipients.length &&
    summaryCount === 1 &&
    batchCount === 1
  );
}
