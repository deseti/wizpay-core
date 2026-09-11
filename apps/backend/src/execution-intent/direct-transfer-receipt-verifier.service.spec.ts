import { ConfigService } from '@nestjs/config';
import { encodeEventTopics, encodeFunctionData, parseAbiItem } from 'viem';
import { DirectTransferReceiptVerifierService } from './direct-transfer-receipt-verifier.service';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

const sender = '0x1000000000000000000000000000000000000001';
const recipient = '0x2000000000000000000000000000000000000002';
const token = '0x3000000000000000000000000000000000000003';
const hash = `0x${'a'.repeat(64)}`;
const transfer = {
  type: 'function',
  name: 'transfer',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [{ name: '', type: 'bool' }],
} as const;
const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

describe('DirectTransferReceiptVerifierService', () => {
  it('requires exact chain, target, sender, calldata, event, success, and confirmations', async () => {
    const verifier = createVerifier();
    await expect(
      verifier.verify({
        transactionHash: hash,
        sender,
        recipient,
        token,
        amountUnits: '1000000',
      }),
    ).resolves.toMatchObject({
      network: 'arc-testnet',
      transactionHash: hash,
      sourceWallet: sender,
      recipient,
      token,
      amountUnits: '1000000',
    });
  });

  it('rejects mismatched calldata even when a matching Transfer log is present', async () => {
    const verifier = createVerifier({ calldataRecipient: sender });
    await expect(
      verifier.verify({
        transactionHash: hash,
        sender,
        recipient,
        token,
        amountUnits: '1000000',
      }),
    ).rejects.toMatchObject({
      response: { code: 'EXECUTION_INTENT_RECEIPT_MISMATCH' },
    });
  });

  it.each([
    ['provider chain', { providerChainId: 5_042 }],
    ['transaction chain', { transactionChainId: 5_042 }],
    ['transaction hash', { returnedHash: `0x${'b'.repeat(64)}` }],
    ['transaction status', { status: 'reverted' as const }],
    ['token target', { transactionTo: sender }],
    ['payer', { transactionFrom: recipient }],
    ['recipient', { calldataRecipient: sender }],
    ['amount', { calldataAmount: 999_999n }],
    ['log token', { logAddress: sender }],
    ['log payer', { logFrom: recipient }],
    ['log recipient', { logTo: sender }],
    ['log amount', { logAmount: 999_999n }],
    ['duplicate transfer', { duplicateLog: true }],
  ])('rejects a wrong %s', async (_label, options) => {
    const verifier = createVerifier(options);
    await expect(
      verifier.verify({
        transactionHash: hash,
        sender,
        recipient,
        token,
        amountUnits: '1000000',
      }),
    ).rejects.toMatchObject({
      response: { code: 'EXECUTION_INTENT_RECEIPT_MISMATCH' },
    });
  });

  it('keeps insufficient confirmations retryable', async () => {
    const verifier = createVerifier({ currentBlock: 10n });
    await expect(
      verifier.verify({
        transactionHash: hash,
        sender,
        recipient,
        token,
        amountUnits: '1000000',
      }),
    ).rejects.toMatchObject({
      response: { code: 'EXECUTION_INTENT_RECEIPT_PENDING', retryable: true },
    });
  });
});

function createVerifier(
  options: {
    providerChainId?: number;
    transactionChainId?: number;
    returnedHash?: Hash;
    status?: 'success' | 'reverted';
    transactionTo?: Address;
    transactionFrom?: Address;
    calldataRecipient?: Address;
    calldataAmount?: bigint;
    logAddress?: Address;
    logFrom?: Address;
    logTo?: Address;
    logAmount?: bigint;
    duplicateLog?: boolean;
    currentBlock?: bigint;
  } = {},
) {
  const config = {
    getOrThrow: jest.fn().mockReturnValue({
      key: 'arc-testnet',
      chainId: 5_042_002,
      rpcUrl: 'http://127.0.0.1:1',
    }),
    get: jest.fn((key: string) =>
      key === 'EXECUTION_INTENT_CONFIRMATIONS_REQUIRED' ? 2 : undefined,
    ),
  } as unknown as ConfigService;
  const verifier = new DirectTransferReceiptVerifierService(config);
  const blockNumber = 10n;
  const input = encodeFunctionData({
    abi: [transfer],
    functionName: 'transfer',
    args: [
      options.calldataRecipient ?? recipient,
      options.calldataAmount ?? 1_000_000n,
    ],
  });
  const topics = encodeEventTopics({
    abi: [transferEvent],
    eventName: 'Transfer',
    args: {
      from: options.logFrom ?? sender,
      to: options.logTo ?? recipient,
    },
  });
  const log = {
    address: options.logAddress ?? token,
    topics,
    data: `0x${(options.logAmount ?? 1_000_000n).toString(16).padStart(64, '0')}`,
  };
  Object.assign(verifier as unknown as { publicClient: unknown }, {
    publicClient: {
      getChainId: jest
        .fn()
        .mockResolvedValue(options.providerChainId ?? 5_042_002),
      getTransaction: jest.fn().mockResolvedValue({
        hash: options.returnedHash ?? hash,
        chainId: options.transactionChainId ?? 5_042_002,
        from: options.transactionFrom ?? sender,
        to: options.transactionTo ?? token,
        value: 0n,
        input,
      }),
      getTransactionReceipt: jest.fn().mockResolvedValue({
        transactionHash: options.returnedHash ?? hash,
        blockNumber,
        status: options.status ?? 'success',
        logs: options.duplicateLog ? [log, log] : [log],
      }),
      getBlockNumber: jest
        .fn()
        .mockResolvedValue(options.currentBlock ?? blockNumber + 1n),
    },
  });
  return verifier;
}
