import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  concatHex,
  encodeAbiParameters,
  encodeEventTopics,
  numberToHex,
  padHex,
  zeroAddress,
  type Hex,
} from 'viem';
import {
  BridgeLifecycleService,
  CCTP_V2_MESSAGE_RECEIVED_EVENT,
  bridgeUnavailable,
  destinationMintReceiptMatches,
  matchesBridgeAttestation,
  matchesBridgeSourceMessage,
  matchesCctpV2MessageReceived,
  matchesExpectedDestinationChain,
  type BridgeIntentPayload,
} from './bridge-lifecycle.service';
import { addressToBytes32, decodeCctpV2Message } from './bridge-message';
import { PrismaService } from '../database/prisma.service';

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const RECIPIENT = '0x2222222222222222222222222222222222222222' as const;
const MAINNET_MESSENGER = '0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d' as const;
const SOURCE_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const ARC_USDC = '0x3600000000000000000000000000000000000000' as const;
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const TX_HASH = `0x${'11'.repeat(32)}`;

function u32(value: number) {
  return numberToHex(value, { size: 4 });
}

function u256(value: bigint) {
  return numberToHex(value, { size: 32 });
}

function cctpMessage(
  overrides: {
    sourceDomain?: number;
    destinationDomain?: number;
    nonce?: Hex;
    finalityThresholdExecuted?: number;
    amount?: bigint;
  } = {},
) {
  return concatHex([
    u32(1),
    u32(overrides.sourceDomain ?? 26),
    u32(overrides.destinationDomain ?? 0),
    overrides.nonce ?? padHex('0x0', { size: 32 }),
    addressToBytes32(MAINNET_MESSENGER),
    addressToBytes32(MAINNET_MESSENGER),
    addressToBytes32(zeroAddress),
    u32(2000),
    u32(overrides.finalityThresholdExecuted ?? 0),
    u32(1),
    addressToBytes32(ARC_USDC),
    addressToBytes32(WALLET),
    u256(overrides.amount ?? 1_000_000n),
    addressToBytes32(WALLET),
    u256(1000n),
    u256(0n),
    u256(0n),
  ]);
}

function matchingAttestationMessage(payload: {
  sourceDomain: number;
  destinationDomain: number;
  amount: bigint;
  maxFee: bigint;
  sender: string;
  recipient: string;
  burnToken: string;
  mintRecipient: string;
  messageSender: string;
}) {
  return concatHex([
    u32(1),
    u32(payload.sourceDomain),
    u32(payload.destinationDomain),
    padHex('0x1234', { size: 32 }),
    addressToBytes32(payload.sender as Hex),
    addressToBytes32(payload.recipient as Hex),
    addressToBytes32(zeroAddress),
    u32(2000),
    u32(2000),
    u32(1),
    addressToBytes32(payload.burnToken as Hex),
    addressToBytes32(payload.mintRecipient as Hex),
    u256(payload.amount),
    addressToBytes32(payload.messageSender as Hex),
    u256(payload.maxFee),
    u256(500n),
    u256(0n),
  ]);
}

function payload(): BridgeIntentPayload {
  return {
    idempotencyKey: OPERATION_ID,
    sourceCode: 'ARC-MAINNET',
    destinationCode: 'ARC-MAINNET',
    sourceChainId: 5042,
    destinationChainId: 5042,
    sourceDomain: 26,
    destinationDomain: 26,
    sourceUsdcAddress: ARC_USDC,
    destinationUsdcAddress: ARC_USDC,
    sourceTokenMessengerV2: MAINNET_MESSENGER,
    destinationTokenMessengerV2: MAINNET_MESSENGER,
    destinationMessageTransmitterV2: MAINNET_MESSENGER,
    walletAddress: WALLET,
    recipientAddress: WALLET,
    destinationCaller: zeroAddress,
    amount: '1000000',
    maxFee: '1000',
    minFinalityThreshold: 2000,
    createdAt: new Date().toISOString(),
  };
}

function request() {
  return {
    idempotencyKey: OPERATION_ID,
    sourceCode: 'ARC-MAINNET',
    destinationCode: 'BASE-MAINNET',
    walletAddress: WALLET,
    recipientAddress: RECIPIENT,
    amount: '1000000',
    maxFee: '1000',
    minFinalityThreshold: 2000,
  };
}

type Row = {
  id: string;
  taskId: string;
  status: string;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  messageHash: string | null;
  nonce: string | null;
  destinationTransactionHash: string | null;
  destinationLeaseId: string | null;
  destinationLeaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function prismaMock() {
  const rows = new Map<string, Row>();
  let counter = 0;
  type BridgeCreateData = {
    taskId: string;
    status: string;
    payload: Record<string, unknown>;
    result?: Record<string, unknown> | null;
  };
  type BridgeUpdateData = Partial<
    Pick<
      Row,
      | 'status'
      | 'payload'
      | 'result'
      | 'messageHash'
      | 'nonce'
      | 'destinationTransactionHash'
      | 'destinationLeaseId'
      | 'destinationLeaseExpiresAt'
    >
  >;
  const bridgeTransaction = {
    findFirst: jest.fn(
      (args: {
        where?: { payload?: { path?: string[]; equals?: string } };
      }): Promise<Row | null> => {
        const key = args.where?.payload?.equals;
        for (const row of rows.values()) {
          if (row.payload.idempotencyKey === key)
            return Promise.resolve({ ...row });
        }
        return Promise.resolve(null);
      },
    ),
    findUnique: jest.fn(
      (args: { where: { id: string } }): Promise<Row | null> => {
        const row = rows.get(args.where.id);
        return Promise.resolve(row ? { ...row } : null);
      },
    ),
    create: jest.fn((args: { data: BridgeCreateData }): Promise<Row> => {
      counter += 1;
      const row: Row = {
        id: `bridge-${counter}`,
        taskId: args.data.taskId,
        status: args.data.status,
        payload: args.data.payload,
        result: args.data.result ?? null,
        messageHash: null,
        nonce: null,
        destinationTransactionHash: null,
        destinationLeaseId: null,
        destinationLeaseExpiresAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.set(row.id, row);
      return Promise.resolve({ ...row });
    }),
    update: jest.fn(
      (args: {
        where: { id: string };
        data: BridgeUpdateData;
      }): Promise<Row> => {
        const row = rows.get(args.where.id);
        if (!row) throw new Error('missing row');
        const next: Row = {
          ...row,
          ...args.data,
          updatedAt: new Date(),
        };
        rows.set(row.id, next);
        return Promise.resolve({ ...next });
      },
    ),
  };
  const task = {
    create: jest.fn((args: { data: Record<string, unknown> }) => {
      counter += 1;
      return Promise.resolve({ id: `task-${counter}`, ...args.data });
    }),
    updateMany: jest.fn((): Promise<{ count: number }> =>
      Promise.resolve({ count: 1 }),
    ),
  };
  type TxClient = {
    task: typeof task;
    bridgeTransaction: typeof bridgeTransaction;
  };
  const txClient: TxClient = { task, bridgeTransaction };
  const prisma = {
    task,
    bridgeTransaction,
    $transaction: jest.fn(
      (fn: (client: TxClient) => Promise<Row>): Promise<Row> => fn(txClient),
    ),
  };
  return { prisma, rows };
}

function service(prisma: unknown) {
  const config = { get: jest.fn().mockReturnValue(undefined) };
  return new BridgeLifecycleService(
    prisma as PrismaService,
    config as unknown as ConfigService,
  );
}

describe('BridgeLifecycleService exposes the unavailable error shape', () => {
  it('keeps BRIDGE_UNAVAILABLE for fail-closed callers', () => {
    expect(bridgeUnavailable()).toBeInstanceOf(ServiceUnavailableException);
    expect(bridgeUnavailable().getResponse()).toMatchObject({
      code: 'BRIDGE_UNAVAILABLE',
    });
  });
});

describe('BridgeLifecycleService official CCTP intents', () => {
  let fetchMock: jest.Mock;
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.clearAllMocks();
  });

  it('creates an Arc-centric intent with official production messengers', async () => {
    const { prisma } = prismaMock();
    const intent = await service(prisma).createIntent(request());

    expect(intent.status).toBe('idle');
    expect(intent.payload.sourceCode).toBe('ARC-MAINNET');
    expect(intent.payload.destinationCode).toBe('BASE-MAINNET');
    expect(intent.payload.sourceDomain).toBe(26);
    expect(intent.payload.destinationDomain).toBe(6);
    expect(intent.payload.sourceTokenMessengerV2).toBe(MAINNET_MESSENGER);
    expect(intent.payload.destinationTokenMessengerV2).toBe(MAINNET_MESSENGER);
    expect(intent.payload.minFinalityThreshold).toBe(2000);
    expect(prisma.task.create).toHaveBeenCalledTimes(1);
    expect(jest.mocked(prisma.task.create).mock.calls[0]?.[0]).toMatchObject({
      data: { type: 'bridge' },
    });
  });

  it('replays the same idempotency key instead of duplicating', async () => {
    const { prisma } = prismaMock();
    const lifecycle = service(prisma);
    const first = await lifecycle.createIntent(request());
    const second = await lifecycle.createIntent(request());
    expect(second.id).toBe(first.id);
    expect(prisma.bridgeTransaction.create).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ ...request(), sourceCode: 'ETH-SEPOLIA' }, 'BRIDGE_CHAIN_UNKNOWN'],
    [{ ...request(), destinationCode: 'BASE-SEPOLIA' }, 'BRIDGE_CHAIN_UNKNOWN'],
    [
      {
        ...request(),
        sourceCode: 'ARC-MAINNET',
        destinationCode: 'ARC-MAINNET',
      },
      'BRIDGE_ROUTE_SAME_CHAIN',
    ],
    [
      {
        ...request(),
        sourceCode: 'ETH-MAINNET',
        destinationCode: 'BASE-MAINNET',
      },
      'BRIDGE_ROUTE_NOT_ARC',
    ],
    [{ ...request(), amount: '10000000000001' }, 'BRIDGE_AMOUNT_ABOVE_MAX'],
    [
      { ...request(), minFinalityThreshold: 1000 },
      'BRIDGE_TRANSFER_MODE_MISMATCH',
    ],
    [
      {
        ...request(),
        sourceCode: 'BASE-MAINNET',
        destinationCode: 'ARC-MAINNET',
        minFinalityThreshold: 2000,
      },
      'BRIDGE_TRANSFER_MODE_MISMATCH',
    ],
  ])('fails closed for invalid intent %j', async (input, code) => {
    const { prisma } = prismaMock();
    await expect(
      service(prisma).createIntent(input as never),
    ).rejects.toMatchObject({ response: { code } });
  });

  it('enforces wallet ownership when reading intents', async () => {
    const { prisma } = prismaMock();
    const lifecycle = service(prisma);
    const intent = await lifecycle.createIntent(request());
    await expect(
      lifecycle.getIntent(intent.id, { walletAddress: WALLET }),
    ).resolves.toMatchObject({ id: intent.id });
    await expect(
      lifecycle.getIntent(intent.id, { walletAddress: RECIPIENT }),
    ).rejects.toMatchObject({
      response: { code: 'BRIDGE_INTENT_FORBIDDEN' },
    });
  });

  it('runs approval, source, attestation, destination, and completion', async () => {
    const { prisma } = prismaMock();
    const lifecycle = service(prisma);
    const created = await lifecycle.createIntent(request());

    const approved = await lifecycle.reportApproval(created.id, {
      walletAddress: WALLET,
      transactionHash: TX_HASH,
    });
    expect(approved.status).toBe('approval_confirmed');

    const sourced = await lifecycle.reportSource(created.id, {
      walletAddress: WALLET,
      transactionHash: TX_HASH,
    });
    expect(sourced.status).toBe('source_confirmed');
    expect(sourced.result?.sourceTransactionHash).toBe(TX_HASH.toLowerCase());

    const message = matchingAttestationMessage({
      sourceDomain: 26,
      destinationDomain: 6,
      amount: 1_000_000n,
      maxFee: 1000n,
      sender: MAINNET_MESSENGER,
      recipient: MAINNET_MESSENGER,
      burnToken: ARC_USDC,
      mintRecipient: RECIPIENT,
      messageSender: WALLET,
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          messages: [
            {
              message,
              attestation: '0xdeadbeef',
              status: 'complete',
            },
          ],
        }),
    });

    const attested = await lifecycle.getAttestation(created.id, {
      walletAddress: WALLET,
    });
    expect(attested.status).toBe('attestation_ready');
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('https://iris-api.circle.com/v2/messages/26'),
      expect.anything(),
    );
    expect(attested.result?.nonce).toBeDefined();

    const authorized = await lifecycle.authorizeDestination(created.id, {
      walletAddress: WALLET,
    });
    expect(authorized.status).toBe('awaiting_destination_signature');
    expect(authorized.destinationLeaseId).toBeDefined();

    const submitted = await lifecycle.submitDestination(created.id, {
      walletAddress: WALLET,
      transactionHash: TX_HASH,
      messageHash: attested.result?.messageHash as Hex,
      leaseId: authorized.destinationLeaseId,
    });
    expect(submitted.status).toBe('verifying_destination');

    const completed = await lifecycle.verifyDestination(created.id, {
      walletAddress: WALLET,
    });
    expect(completed.status).toBe('completed');
    expect(completed.result?.completedAt).toBeDefined();
  });

  it('stays pending when the Circle attestation is not ready', async () => {
    const { prisma } = prismaMock();
    const lifecycle = service(prisma);
    const created = await lifecycle.createIntent(request());
    await lifecycle.reportSource(created.id, {
      walletAddress: WALLET,
      transactionHash: TX_HASH,
    });
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const pending = await lifecycle.getAttestation(created.id, {
      walletAddress: WALLET,
    });
    expect(pending.status).toBe('waiting_for_attestation');
  });

  it('creates Fast intents for Base source when Circle fee and allowance permit', async () => {
    const { prisma } = prismaMock();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            { sourceDomain: 6, destinationDomain: 26, finalityThreshold: 1000, minimumFee: 1.3 },
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ allowance: 999999 }),
      });
    const created = await service(prisma).createIntent({
      ...request(),
      sourceCode: 'BASE-MAINNET',
      destinationCode: 'ARC-MAINNET',
      amount: '10000000',
      maxFee: '1600',
      minFinalityThreshold: 1000,
    });
    expect(created.payload.minFinalityThreshold).toBe(1000);
  });

  it('fails closed for Fast intents when allowance is insufficient', async () => {
    const { prisma } = prismaMock();
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve([
            { sourceDomain: 6, destinationDomain: 26, finalityThreshold: 1000, minimumFee: 1.3 },
          ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ allowance: 1 }),
      });
    await expect(
      service(prisma).createIntent({
        ...request(),
        sourceCode: 'BASE-MAINNET',
        destinationCode: 'ARC-MAINNET',
        amount: '10000000',
        maxFee: '200',
        minFinalityThreshold: 1000,
      }),
    ).rejects.toMatchObject({ response: { code: 'BRIDGE_FAST_UNAVAILABLE' } });
  });

  it('rejects conflicting approval hashes instead of overwriting', async () => {
    const { prisma } = prismaMock();
    const lifecycle = service(prisma);
    const created = await lifecycle.createIntent(request());
    await lifecycle.reportApproval(created.id, {
      walletAddress: WALLET,
      transactionHash: TX_HASH,
    });
    await expect(
      lifecycle.reportApproval(created.id, {
        walletAddress: WALLET,
        transactionHash: `0x${'22'.repeat(32)}`,
      }),
    ).rejects.toMatchObject({ response: { code: 'BRIDGE_HASH_CONFLICT' } });
  });
});

describe('Bridge codec matchers', () => {
  it('matches identical destination chains and rejects mismatches', () => {
    expect(matchesExpectedDestinationChain(5042, 5042)).toBe(true);
    expect(matchesExpectedDestinationChain(11155111, 5042)).toBe(false);
  });

  it('matches a canonical source message with zero finality executed', () => {
    const decoded = decodeCctpV2Message(cctpMessage({ destinationDomain: 26 }));
    expect(matchesBridgeSourceMessage(payload(), decoded)).toBe(true);
    expect(
      matchesBridgeSourceMessage(payload(), {
        ...decoded,
        amount: 2_000_000n,
      }),
    ).toBe(false);
  });

  it('matches a canonical attestation once finality executed', () => {
    const message = cctpMessage({
      destinationDomain: 26,
      nonce: padHex('0x1234', { size: 32 }),
      finalityThresholdExecuted: 2000,
    });
    const decoded = decodeCctpV2Message(message);
    const candidate = {
      ...payload(),
      destinationDomain: 26,
    };
    expect(matchesBridgeAttestation(candidate, decoded)).toBe(true);
    expect(
      matchesBridgeAttestation(
        candidate,
        decoded,
        padHex('0x99', { size: 32 }),
      ),
    ).toBe(false);
  });

  it('accepts only a MessageReceived log from the destination transmitter', () => {
    const messageBody = '0x01020304' as Hex;
    const nonce = padHex('0x1234', { size: 32 });
    const sender = addressToBytes32(MAINNET_MESSENGER);
    const topics = encodeEventTopics({
      abi: CCTP_V2_MESSAGE_RECEIVED_EVENT,
      eventName: 'MessageReceived',
      args: { caller: WALLET, nonce, finalityThresholdExecuted: 2000 },
    });
    const data = encodeAbiParameters(
      [{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }],
      [26, sender, messageBody],
    );
    const log = { address: MAINNET_MESSENGER, topics, data };
    const expected = {
      messageTransmitter: MAINNET_MESSENGER,
      sourceDomain: 26,
      nonce,
      sender,
      finalityThresholdExecuted: 2000,
      messageBody,
    };
    expect(destinationMintReceiptMatches([log], expected)).toBe(true);
    expect(
      destinationMintReceiptMatches([log], {
        ...expected,
        messageBody: '0xffff',
      }),
    ).toBe(false);
    expect(
      destinationMintReceiptMatches([{ ...log, address: RECIPIENT }], expected),
    ).toBe(false);
  });

  it('matches received-event bindings exactly', () => {
    const nonce = padHex('0x1234', { size: 32 });
    const args = {
      caller: WALLET,
      sourceDomain: 26,
      nonce,
      sender: addressToBytes32(MAINNET_MESSENGER),
      finalityThresholdExecuted: 2000,
      messageBody: '0x01020304' as Hex,
    };
    const expected = { ...args };
    expect(matchesCctpV2MessageReceived(args, expected)).toBe(true);
    expect(
      matchesCctpV2MessageReceived({ ...args, sourceDomain: 0 }, expected),
    ).toBe(false);
  });
});
