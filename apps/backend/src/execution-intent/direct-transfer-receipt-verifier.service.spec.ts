import { ConfigService } from '@nestjs/config';
import {
  encodeEventTopics,
  encodeFunctionData,
  parseAbiItem,
  type Address,
  type Hash,
} from 'viem';
import { DirectTransferReceiptVerifierService } from './direct-transfer-receipt-verifier.service';

const sender = '0x1000000000000000000000000000000000000001';
const recipient = '0x2000000000000000000000000000000000000002';
const token = '0x3000000000000000000000000000000000000003';
const hash = `0x${'a'.repeat(64)}` as Hash;
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
  options: { calldataRecipient?: Address; currentBlock?: bigint } = {},
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
    args: [options.calldataRecipient ?? recipient, 1_000_000n],
  });
  const topics = encodeEventTopics({
    abi: [transferEvent],
    eventName: 'Transfer',
    args: { from: sender, to: recipient },
  });
  Object.assign(verifier as unknown as { publicClient: unknown }, {
    publicClient: {
      getChainId: jest.fn().mockResolvedValue(5_042_002),
      getTransaction: jest.fn().mockResolvedValue({
        hash,
        chainId: 5_042_002,
        from: sender,
        to: token,
        value: 0n,
        input,
      }),
      getTransactionReceipt: jest.fn().mockResolvedValue({
        transactionHash: hash,
        blockNumber,
        status: 'success',
        logs: [
          {
            address: token,
            topics,
            data: `0x${1_000_000n.toString(16).padStart(64, '0')}`,
          },
        ],
      }),
      getBlockNumber: jest
        .fn()
        .mockResolvedValue(options.currentBlock ?? blockNumber + 1n),
    },
  });
  return verifier;
}
