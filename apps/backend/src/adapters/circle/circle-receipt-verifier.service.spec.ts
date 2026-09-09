import { ConfigService } from '@nestjs/config';
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbiItem,
} from 'viem';
import {
  CircleReceiptVerificationError,
  CircleReceiptVerifierService,
} from './circle-receipt-verifier.service';

const TOKEN = getAddress('0x3600000000000000000000000000000000000000');
const SENDER = getAddress('0x1111111111111111111111111111111111111111');
const RECIPIENT = getAddress('0x2222222222222222222222222222222222222222');
const OTHER = getAddress('0x3333333333333333333333333333333333333333');
const HASH = `0x${'a'.repeat(64)}` as const;
const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

function configuration() {
  const arcNetwork = {
    key: 'arc-testnet',
    chainId: 5_042_002,
    environment: 'testnet',
    rpcUrl: 'https://rpc.test.invalid',
    explorerBaseUrl: 'https://explorer.test.invalid',
    tokens: {
      USDC: { symbol: 'USDC', address: TOKEN, decimals: 6 },
      EURC: {
        symbol: 'EURC',
        address: getAddress('0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a'),
        decimals: 6,
      },
    },
    contracts: {},
  };
  const values: Record<string, unknown> = {
    arcNetwork,
    'arcNetwork.key': 'arc-testnet',
    CIRCLE_TESTNET_API_BASE_URL: 'https://api.circle.test',
    CIRCLE_TESTNET_API_KEY: 'test-api-key',
    CIRCLE_TESTNET_ENTITY_SECRET: 'test-entity-secret',
    CIRCLE_TESTNET_WALLET_SET_ID: 'test-wallet-set',
    CIRCLE_TESTNET_WALLET_ID: 'test-wallet-id',
    CIRCLE_TESTNET_WALLET_ADDRESS: SENDER,
    CIRCLE_TESTNET_RECEIPT_CONFIRMATIONS: '2',
  };
  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (values[key] === undefined) throw new Error(`Missing ${key}`);
      return values[key];
    }),
  } as unknown as ConfigService;
}

function transferLog(from = SENDER, to = RECIPIENT, amount = 1_000_000n) {
  return {
    address: TOKEN,
    topics: encodeEventTopics({
      abi: [TRANSFER],
      eventName: 'Transfer',
      args: { from, to },
    }),
    data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
  };
}

function publicClient(overrides: Record<string, unknown> = {}) {
  return {
    getChainId: jest.fn().mockResolvedValue(5_042_002),
    getTransaction: jest.fn().mockResolvedValue({
      hash: HASH,
      chainId: 5_042_002,
      from: SENDER,
      to: TOKEN,
      value: 0n,
    }),
    getTransactionReceipt: jest.fn().mockResolvedValue({
      transactionHash: HASH,
      status: 'success',
      blockNumber: 10n,
      logs: [transferLog()],
    }),
    getBlockNumber: jest.fn().mockResolvedValue(11n),
    ...overrides,
  };
}

function serviceWith(client = publicClient()) {
  const service = new CircleReceiptVerifierService(configuration());
  (service as unknown as { publicClient: unknown }).publicClient = client;
  return service;
}

const input = {
  transactionHash: HASH,
  senderAddress: SENDER,
  recipientAddress: RECIPIENT,
  tokenAddress: TOKEN,
  amountUnits: 1_000_000n,
  circleBlockchain: 'ARC-TESTNET',
} as const;

describe('CircleReceiptVerifierService', () => {
  it('accepts one exact selected-chain token transfer with confirmations', async () => {
    await expect(serviceWith().verifyTransfer(input)).resolves.toBeUndefined();
  });

  it('keeps a missing receipt or insufficient confirmations retryable', async () => {
    for (const client of [
      publicClient({
        getTransactionReceipt: jest
          .fn()
          .mockRejectedValue(new Error('missing')),
      }),
      publicClient({ getBlockNumber: jest.fn().mockResolvedValue(10n) }),
    ]) {
      await expect(
        serviceWith(client).verifyTransfer(input),
      ).rejects.toMatchObject({
        retryable: true,
      });
    }
  });

  it.each([
    [
      'failed receipt',
      publicClient({
        getTransactionReceipt: jest.fn().mockResolvedValue({
          transactionHash: HASH,
          status: 'reverted',
          blockNumber: 10n,
          logs: [transferLog()],
        }),
      }),
    ],
    [
      'wrong provider chain',
      publicClient({ getChainId: jest.fn().mockResolvedValue(5042) }),
    ],
    [
      'wrong transaction chain',
      publicClient({
        getTransaction: jest.fn().mockResolvedValue({
          hash: HASH,
          chainId: 5042,
          from: SENDER,
          to: TOKEN,
          value: 0n,
        }),
      }),
    ],
    [
      'wrong transaction hash',
      publicClient({
        getTransaction: jest.fn().mockResolvedValue({
          hash: `0x${'b'.repeat(64)}`,
          chainId: 5_042_002,
          from: SENDER,
          to: TOKEN,
          value: 0n,
        }),
      }),
    ],
    [
      'wrong target contract',
      publicClient({
        getTransaction: jest.fn().mockResolvedValue({
          hash: HASH,
          chainId: 5_042_002,
          from: SENDER,
          to: OTHER,
          value: 0n,
        }),
      }),
    ],
    [
      'wrong token log',
      publicClient({
        getTransactionReceipt: jest.fn().mockResolvedValue({
          transactionHash: HASH,
          status: 'success',
          blockNumber: 10n,
          logs: [{ ...transferLog(), address: OTHER }],
        }),
      }),
    ],
    [
      'wrong sender',
      publicClient({
        getTransaction: jest.fn().mockResolvedValue({
          hash: HASH,
          chainId: 5_042_002,
          from: OTHER,
          to: TOKEN,
          value: 0n,
        }),
      }),
    ],
    [
      'wrong recipient',
      publicClient({
        getTransactionReceipt: jest.fn().mockResolvedValue({
          transactionHash: HASH,
          status: 'success',
          blockNumber: 10n,
          logs: [transferLog(SENDER, OTHER)],
        }),
      }),
    ],
    [
      'wrong amount',
      publicClient({
        getTransactionReceipt: jest.fn().mockResolvedValue({
          transactionHash: HASH,
          status: 'success',
          blockNumber: 10n,
          logs: [transferLog(SENDER, RECIPIENT, 999_999n)],
        }),
      }),
    ],
  ])('rejects %s', async (_name, client) => {
    await expect(
      serviceWith(client).verifyTransfer(input),
    ).rejects.toBeInstanceOf(CircleReceiptVerificationError);
    await expect(
      serviceWith(client).verifyTransfer(input),
    ).rejects.toMatchObject({
      retryable: false,
      code: 'CIRCLE_RECEIPT_VERIFICATION_FAILED',
    });
  });

  it('rejects a Circle blockchain mismatch before querying RPC', async () => {
    const client = publicClient();
    await expect(
      serviceWith(client).verifyTransfer({
        ...input,
        circleBlockchain: 'ARC',
      }),
    ).rejects.toMatchObject({ retryable: false });
    expect(client.getChainId).not.toHaveBeenCalled();
  });
});
