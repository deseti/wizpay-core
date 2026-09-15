import { ConfigService } from '@nestjs/config';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  keccak256,
  parseAbiItem,
  parseAbiParameters,
  type Address,
  type Hash,
} from 'viem';
import { PayrollReceiptVerifierService } from './payroll-receipt-verifier.service';
import { createPayrollBatchDigest } from '../execution-intent/execution-intent.service';

const payer: Address = '0x1000000000000000000000000000000000000001';
const recipient: Address = '0x2000000000000000000000000000000000000002';
const usdc: Address = '0x3000000000000000000000000000000000000003';
const contract: Address = '0x4000000000000000000000000000000000000004';
const hash = `0x${'a'.repeat(64)}` as Hash;
const reference = 'PAYROLL-1-BATCH-0';
const payrollAbi = [
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
const batchEvent = parseAbiItem(
  'event BatchPaymentRouted(address indexed sender, address tokenIn, address tokenOut, uint256 totalAmountIn, uint256 totalAmountOut, uint256 totalFees, uint256 recipientCount, string referenceId)',
);
const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);
const mainnetPaymentEvent = parseAbiItem(
  'event DirectUsdcPayment(bytes32 indexed referenceHash, address indexed payer, address indexed recipient, uint256 paymentIndex, uint256 grossAmount, uint256 netAmount, uint256 feeAmount)',
);
const mainnetReferenceEvent = parseAbiItem(
  'event PayrollReferenceConsumed(bytes32 indexed referenceHash, address indexed payer, address indexed token, bytes32 batchDigest, uint256 totalAmount, uint256 totalOut, uint256 totalFees, uint256 recipientCount, string referenceId)',
);
const feeRecipient: Address = '0x5000000000000000000000000000000000000005';

describe('PayrollReceiptVerifierService', () => {
  it('accepts only the exact payer, contract, calldata, batch event, transfer, chain, and confirmations', async () => {
    await expect(service().verify(input())).resolves.toMatchObject({
      transactionHash: hash,
      batchDigest: input().expectedBatchDigest,
      amountUnits: '1000000',
    });
  });

  it('rejects a changed recipient amount even when the transaction succeeded', async () => {
    await expect(
      service().verify({
        ...input(),
        recipients: [{ address: recipient, amountUnits: '999999' }],
      }),
    ).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECEIPT_MISMATCH', retryable: false },
    });
  });

  it.each([
    ['wrong persisted digest', { expectedBatchDigest: 'b'.repeat(64) }],
    ['wrong persisted total', { totalAmountUnits: '1000001' }],
    ['wrong payer', { sourceWallet: recipient }],
    ['wrong token', { token: recipient }],
    ['stale task reference', { referenceId: 'PAYROLL-OTHER-BATCH-0' }],
  ])('rejects %s', async (_label, change) => {
    await expect(service().verify({ ...input(), ...change })).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECEIPT_MISMATCH', retryable: false },
    });
  });

  it('rejects a returned transaction hash substitution', async () => {
    await expect(
      service(11n, { returnedHash: `0x${'b'.repeat(64)}` as Hash }).verify(input()),
    ).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECEIPT_MISMATCH', retryable: false },
    });
  });

  it('rejects a receipt hash substitution and a reverted replacement', async () => {
    await expect(
      service(11n, { receiptHash: `0x${'b'.repeat(64)}` as Hash }).verify(input()),
    ).rejects.toMatchObject({ response: { code: 'PAYROLL_RECEIPT_MISMATCH' } });
    await expect(
      service(11n, { status: 'reverted' }).verify(input()),
    ).rejects.toMatchObject({ response: { code: 'PAYROLL_RECEIPT_MISMATCH' } });
  });

  it('rejects partial and reordered intent recipient sets', async () => {
    const second: Address = '0x6000000000000000000000000000000000000006';
    const two = [
      { address: recipient, amountUnits: '1000000' },
      { address: second, amountUnits: '2000000' },
    ];
    const total = '3000000';
    const digest = createPayrollBatchDigest(
      two.map((entry) => ({ recipient: entry.address, token: usdc, amountUnits: entry.amountUnits })),
    );
    await expect(
      service().verify({ ...input(), recipients: two, totalAmountUnits: total, expectedBatchDigest: digest }),
    ).rejects.toMatchObject({ response: { code: 'PAYROLL_RECEIPT_MISMATCH' } });
    const reordered = [...two].reverse();
    await expect(
      service().verify({
        ...input(),
        recipients: reordered,
        totalAmountUnits: total,
        expectedBatchDigest: createPayrollBatchDigest(
          reordered.map((entry) => ({ recipient: entry.address, token: usdc, amountUnits: entry.amountUnits })),
        ),
      }),
    ).rejects.toMatchObject({ response: { code: 'PAYROLL_RECEIPT_MISMATCH' } });
  });

  it('rejects duplicate recipients on Arc Mainnet', async () => {
    const duplicate = [
      { address: recipient, amountUnits: '1000000' },
      { address: recipient, amountUnits: '1000000' },
    ];
    await expect(
      mainnetService(999_000n, { recipients: duplicate }).verify({
        ...input(),
        recipients: duplicate,
        totalAmountUnits: '2000000',
        expectedBatchDigest: createPayrollBatchDigest(
          duplicate.map((entry) => ({ recipient: entry.address, token: usdc, amountUnits: entry.amountUnits })),
        ),
      }),
    ).rejects.toMatchObject({ response: { code: 'PAYROLL_RECEIPT_MISMATCH' } });
  });

  it('keeps missing confirmations retryable', async () => {
    await expect(service(10n).verify(input())).rejects.toMatchObject({
      response: { code: 'PAYROLL_CONFIRMATIONS_PENDING', retryable: true },
    });
  });

  it('accepts the final Mainnet domain-bound events and exact fee conservation', async () => {
    await expect(mainnetService().verify(input())).resolves.toMatchObject({
      network: 'arc-mainnet',
      batchDigest: input().expectedBatchDigest,
      amountUnits: '1000000',
    });
  });

  it('rejects a Mainnet payment event with a mismatched net amount', async () => {
    await expect(
      mainnetService(998_999n).verify(input()),
    ).rejects.toMatchObject({
      response: { code: 'PAYROLL_RECEIPT_MISMATCH', retryable: false },
    });
  });
});

function input() {
  return {
    transactionHash: hash,
    sourceWallet: payer,
    token: usdc,
    totalAmountUnits: '1000000',
    expectedBatchDigest: createPayrollBatchDigest([
      { recipient, token: usdc, amountUnits: '1000000' },
    ]),
    referenceId: reference,
    recipients: [{ address: recipient, amountUnits: '1000000' }],
  };
}

function service(
  currentBlock = 11n,
  overrides: {
    returnedHash?: Hash;
    receiptHash?: Hash;
    status?: 'success' | 'reverted';
  } = {},
) {
  const config = {
    getOrThrow: jest.fn().mockReturnValue({
      key: 'arc-testnet',
      chainId: 5_042_002,
      rpcUrl: 'http://127.0.0.1:1',
      contracts: { wizpay: { address: contract } },
    }),
    get: jest.fn((key: string) =>
      key === 'INVOICE_CONFIRMATIONS_REQUIRED' ? 2 : undefined,
    ),
  } as unknown as ConfigService;
  const verifier = new PayrollReceiptVerifierService(config);
  const transactionInput = encodeFunctionData({
    abi: payrollAbi,
    functionName: 'batchRouteAndPay',
    args: [usdc, [usdc], [recipient], [1_000_000n], [1_000_000n], reference],
  });
  const batchTopics = encodeEventTopics({
    abi: [batchEvent],
    eventName: 'BatchPaymentRouted',
    args: { sender: payer },
  });
  const transferTopics = encodeEventTopics({
    abi: [transferEvent],
    eventName: 'Transfer',
    args: { from: contract, to: recipient },
  });
  Object.assign(verifier as unknown as { client: unknown }, {
    client: {
      getChainId: jest.fn().mockResolvedValue(5_042_002),
      getTransaction: jest.fn().mockResolvedValue({
        hash: overrides.returnedHash ?? hash,
        chainId: 5_042_002,
        from: payer,
        to: contract,
        value: 0n,
        input: transactionInput,
      }),
      getTransactionReceipt: jest.fn().mockResolvedValue({
        transactionHash: overrides.receiptHash ?? hash,
        blockNumber: 10n,
        status: overrides.status ?? 'success',
        logs: [
          {
            address: contract,
            topics: batchTopics,
            data: encodeAbiParameters(
              parseAbiParameters(
                'address, address, uint256, uint256, uint256, uint256, string',
              ),
              [usdc, usdc, 1_000_000n, 1_000_000n, 0n, 1n, reference],
            ),
          },
          {
            address: usdc,
            topics: transferTopics,
            data: encodeAbiParameters(parseAbiParameters('uint256'), [
              1_000_000n,
            ]),
          },
        ],
      }),
      getBlockNumber: jest.fn().mockResolvedValue(currentBlock),
    },
  });
  return verifier;
}

function mainnetService(
  netAmount = 999_000n,
  options: { recipients?: readonly { address: Address; amountUnits: string }[] } = {},
) {
  const config = {
    getOrThrow: jest.fn().mockReturnValue({
      key: 'arc-mainnet',
      chainId: 5_042,
      rpcUrl: 'http://127.0.0.1:1',
      contracts: { wizpay: { address: contract } },
    }),
    get: jest.fn().mockReturnValue(2),
  } as unknown as ConfigService;
  const verifier = new PayrollReceiptVerifierService(config);
  const transactionRecipients = options.recipients ?? [
    { address: recipient, amountUnits: '1000000' },
  ];
  const transactionInput = encodeFunctionData({
    abi: payrollAbi,
    functionName: 'batchRouteAndPay',
    args: [
      usdc,
      transactionRecipients.map(() => usdc),
      transactionRecipients.map((entry) => entry.address),
      transactionRecipients.map((entry) => BigInt(entry.amountUnits)),
      transactionRecipients.map(() => 999_000n),
      reference,
    ],
  });
  const referenceHash = keccak256(
    encodeAbiParameters(
      parseAbiParameters('uint256, address, address, address, string'),
      [5_042n, contract, payer, usdc, reference],
    ),
  );
  const batchDigest = keccak256(
    encodeAbiParameters(
      parseAbiParameters(
        'uint256, address, address, address, address[], uint256[]',
      ),
      [5_042n, contract, payer, usdc, [recipient], [1_000_000n]],
    ),
  );
  const paymentTopics = encodeEventTopics({
    abi: [mainnetPaymentEvent],
    eventName: 'DirectUsdcPayment',
    args: { referenceHash, payer, recipient },
  });
  const referenceTopics = encodeEventTopics({
    abi: [mainnetReferenceEvent],
    eventName: 'PayrollReferenceConsumed',
    args: { referenceHash, payer, token: usdc },
  });
  const incomingTopics = encodeEventTopics({
    abi: [transferEvent],
    eventName: 'Transfer',
    args: { from: payer, to: contract },
  });
  const feeTopics = encodeEventTopics({
    abi: [transferEvent],
    eventName: 'Transfer',
    args: { from: contract, to: feeRecipient },
  });
  const recipientTopics = encodeEventTopics({
    abi: [transferEvent],
    eventName: 'Transfer',
    args: { from: contract, to: recipient },
  });
  Object.assign(verifier as unknown as { client: unknown }, {
    client: {
      getChainId: jest.fn().mockResolvedValue(5_042),
      getTransaction: jest.fn().mockResolvedValue({
        hash,
        chainId: 5_042,
        from: payer,
        to: contract,
        value: 0n,
        input: transactionInput,
      }),
      getTransactionReceipt: jest.fn().mockResolvedValue({
        transactionHash: hash,
        blockNumber: 10n,
        status: 'success',
        logs: [
          {
            address: usdc,
            topics: incomingTopics,
            data: encodeAbiParameters(parseAbiParameters('uint256'), [
              1_000_000n,
            ]),
          },
          {
            address: usdc,
            topics: feeTopics,
            data: encodeAbiParameters(parseAbiParameters('uint256'), [1_000n]),
          },
          {
            address: usdc,
            topics: recipientTopics,
            data: encodeAbiParameters(parseAbiParameters('uint256'), [
              999_000n,
            ]),
          },
          {
            address: contract,
            topics: paymentTopics,
            data: encodeAbiParameters(
              parseAbiParameters('uint256, uint256, uint256, uint256'),
              [0n, 1_000_000n, netAmount, 1_000n],
            ),
          },
          {
            address: contract,
            topics: referenceTopics,
            data: encodeAbiParameters(
              parseAbiParameters(
                'bytes32, uint256, uint256, uint256, uint256, string',
              ),
              [batchDigest, 1_000_000n, 999_000n, 1_000n, 1n, reference],
            ),
          },
        ],
      }),
      getBlockNumber: jest.fn().mockResolvedValue(11n),
    },
  });
  return verifier;
}
