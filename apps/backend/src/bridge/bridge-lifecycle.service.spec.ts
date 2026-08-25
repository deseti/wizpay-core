import { BadRequestException, ConflictException } from '@nestjs/common';
import type { BridgeTransaction } from '@prisma/client';
import {
  concatHex,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  numberToHex,
  padHex,
  parseAbi,
  type Hex,
} from 'viem';
import {
  BridgeLifecycleService,
  CCTP_V2_MESSAGE_SENT_EVENT,
  CCTP_V2_MESSAGE_RECEIVED_EVENT,
  matchesCctpV2MessageReceived,
  matchesBridgeAttestation,
  matchesExpectedDestinationChain,
  type BridgeIntentPayload,
} from './bridge-lifecycle.service';
import { addressToBytes32, decodeCctpV2Message } from './bridge-message';

const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as const;
const MESSAGE_TRANSMITTER =
  '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275' as const;
const SOURCE_USDC = '0x3600000000000000000000000000000000000000' as const;
const DESTINATION_USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' as const;
const DESTINATION_HASH = `0x${'77'.repeat(32)}` as Hex;

function createHarness(existing: BridgeTransaction | null = null) {
  const now = new Date();
  const tx = {
    task: {
      create: jest
        .fn()
        .mockResolvedValue({ id: '22222222-2222-4222-8222-222222222222' }),
      update: jest.fn(),
    },
    taskLog: { create: jest.fn() },
    bridgeTransaction: {
      create: jest.fn().mockImplementation(({ data }) => ({
        ...data,
        createdAt: now,
        updatedAt: now,
      })),
      update: jest.fn(),
    },
  };
  const prisma = {
    bridgeTransaction: { findUnique: jest.fn().mockResolvedValue(existing) },
    $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
  };
  return { service: new BridgeLifecycleService(prisma as never), prisma, tx };
}

function request(sourceCode = 'ARC-TESTNET', destinationCode = 'BASE-SEPOLIA') {
  return {
    idempotencyKey: OPERATION_ID,
    sourceCode,
    destinationCode,
    walletAddress: WALLET,
    recipientAddress: WALLET,
    amount: '1000000',
    maxFee: '1000',
    minFinalityThreshold: 2000,
  };
}

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
    sender?: Hex;
    recipient?: Hex;
    amount?: bigint;
    finalityThresholdExecuted?: number;
    burnToken?: `0x${string}`;
  } = {},
) {
  return concatHex([
    u32(1),
    u32(overrides.sourceDomain ?? 26),
    u32(overrides.destinationDomain ?? 0),
    overrides.nonce ?? padHex('0x0', { size: 32 }),
    overrides.sender ?? addressToBytes32(TOKEN_MESSENGER),
    overrides.recipient ?? addressToBytes32(TOKEN_MESSENGER),
    addressToBytes32(WALLET),
    u32(2000),
    u32(overrides.finalityThresholdExecuted ?? 0),
    u32(1),
    addressToBytes32(overrides.burnToken ?? SOURCE_USDC),
    addressToBytes32(WALLET),
    u256(overrides.amount ?? 1_000_000n),
    addressToBytes32(WALLET),
    u256(1000n),
    u256(0n),
    u256(0n),
  ]);
}

function legacyRecoveryHarness(result: Record<string, unknown> = {}) {
  const message = cctpMessage();
  const canonicalMessage = cctpMessage({
    nonce: padHex('0x1234', { size: 32 }),
    finalityThresholdExecuted: 2000,
  });
  const existing = {
    id: OPERATION_ID,
    taskId: '22222222-2222-4222-8222-222222222222',
    status: 'attestation_ready',
    payload: {
      ...request('ARC-TESTNET', 'ETH-SEPOLIA'),
      sourceChainId: 5_042_002,
      destinationChainId: 11_155_111,
      sourceDomain: 26,
      destinationDomain: 0,
      sourceUsdcAddress: SOURCE_USDC,
      destinationUsdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      sourceTokenMessengerV2: TOKEN_MESSENGER,
      sourceMessageTransmitterV2: MESSAGE_TRANSMITTER,
      destinationTokenMessengerV2: TOKEN_MESSENGER,
      destinationMessageTransmitterV2: MESSAGE_TRANSMITTER,
      destinationCaller: WALLET,
    },
    result: {
      sourceTransactionHash: `0x${'11'.repeat(32)}`,
      nonce: padHex('0x1234', { size: 32 }),
      messageHash: undefined,
      ...result,
    },
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as BridgeTransaction;
  const now = new Date();
  const tx = {
    bridgeTransaction: {
      update: jest.fn().mockImplementation(({ data }) => ({
        ...existing,
        ...data,
        updatedAt: now,
      })),
    },
    task: { update: jest.fn() },
    taskLog: { create: jest.fn() },
  };
  const prisma = {
    bridgeTransaction: {
      findUnique: jest.fn().mockResolvedValue(existing),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
  };
  const service = new BridgeLifecycleService(prisma as never);
  const receipt = {
    status: 'success',
    from: WALLET,
    to: TOKEN_MESSENGER,
    logs: [
      {
        address: MESSAGE_TRANSMITTER,
        topics: encodeEventTopics({
          abi: CCTP_V2_MESSAGE_SENT_EVENT,
          eventName: 'MessageSent',
        }),
        data: encodeAbiParameters([{ type: 'bytes' }], [message]),
      },
    ],
  };
  const client = {
    getChainId: jest.fn().mockResolvedValue(5_042_002),
    getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
  };
  (service as unknown as { getClient: jest.Mock }).getClient = jest
    .fn()
    .mockReturnValue(client);
  return { service, existing, tx, prisma, client, message, canonicalMessage };
}

describe('BridgeLifecycleService intent policy', () => {
  it.each([
    'ETH-SEPOLIA',
    'BASE-SEPOLIA',
    'ARB-SEPOLIA',
    'OP-SEPOLIA',
    'MONAD-TESTNET',
  ])('persists a non-custodial Arc intent for %s', async (destinationCode) => {
    const { service, tx } = createHarness();
    const created = await service.createIntent(
      request('ARC-TESTNET', destinationCode),
    );
    expect(created.status).toBe('idle');
    expect(created.intent.destinationCode).toBe(destinationCode);
    expect(created.intent.destinationCaller).toBe(WALLET);
    expect(tx.task.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'bridge',
          status: 'in_progress',
        }),
      }),
    );
  });

  it('supports the reverse spoke-to-Arc direction', async () => {
    const { service } = createHarness();
    const created = await service.createIntent(
      request('MONAD-TESTNET', 'ARC-TESTNET'),
    );
    expect(created.intent.sourceCode).toBe('MONAD-TESTNET');
  });

  it.each([
    ['BASE-SEPOLIA', 'OP-SEPOLIA'],
    ['ROBINHOOD-TESTNET', 'ARC-TESTNET'],
    ['SOLANA-DEVNET', 'ARC-TESTNET'],
    ['BASE', 'ARC-TESTNET'],
  ])(
    'fails closed for unsupported route %s -> %s',
    async (sourceCode, destinationCode) => {
      const { service, prisma } = createHarness();
      await expect(
        service.createIntent(request(sourceCode, destinationCode)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('requires the connected wallet to be the destination recipient', async () => {
    const { service } = createHarness();
    await expect(
      service.createIntent({ ...request(), recipientAddress: OTHER }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'BRIDGE_RECIPIENT_MISMATCH' }),
    });
  });

  it('rejects an idempotency key already bound to another intent', async () => {
    const payload = {
      ...request(),
      sourceChainId: 5_042_002,
      destinationChainId: 84_532,
      sourceDomain: 26,
      destinationDomain: 6,
      sourceUsdcAddress: '0x3600000000000000000000000000000000000000',
      destinationUsdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      sourceTokenMessengerV2: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      destinationTokenMessengerV2: '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA',
      destinationMessageTransmitterV2:
        '0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275',
      destinationCaller: WALLET,
      createdAt: new Date().toISOString(),
    };
    const existing = {
      id: OPERATION_ID,
      taskId: '22222222-2222-4222-8222-222222222222',
      status: 'idle',
      payload,
      result: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as BridgeTransaction;
    const { service } = createHarness(existing);
    await expect(
      service.createIntent({ ...request(), amount: '2000000' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('BridgeLifecycleService destination receipt guards', () => {
  it('rejects a reverted destination receipt', () => {
    const { service } = createHarness();
    expect(() =>
      (service as any).assertSuccessfulReceipt(
        {
          status: 'reverted',
          from: WALLET,
          to: WALLET,
        },
        WALLET,
        WALLET,
      ),
    ).toThrow('signer, target, or status');
  });

  it('rejects a receipt emitted by the wrong MessageTransmitter contract', () => {
    const { service } = createHarness();
    expect(() =>
      (service as any).decodeMatchingLog(
        [
          {
            address: OTHER,
            data: '0x',
            topics: [],
          },
        ],
        [],
        'MessageReceived',
        WALLET,
      ),
    ).toThrow('missing the expected MessageReceived event');
  });

  it('rejects a receipt fetched from the wrong destination chain', () => {
    expect(matchesExpectedDestinationChain(11155111, 5042002)).toBe(false);
    expect(matchesExpectedDestinationChain(11155111, 11155111)).toBe(true);
  });
});

describe('BridgeLifecycleService legacy attestation recovery', () => {
  afterEach(() => jest.restoreAllMocks());

  it('recovers and persists the canonical source MessageSent message', async () => {
    const harness = legacyRecoveryHarness();
    const attestation = `0x${'aa'.repeat(65)}` as Hex;
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            status: 'complete',
            message: harness.canonicalMessage,
            attestation,
          },
        ],
      }),
    } as Response);

    const response = await harness.service.getAttestation(OPERATION_ID, {
      walletAddress: WALLET,
    });

    expect(response.status).toBe('attestation_ready');
    expect(response.attestationStatus).toBe('complete');
    expect(response.result.attestedMessage).toBe(harness.canonicalMessage);
    expect(response.result.attestation).toBe(attestation);
    expect(harness.tx.bridgeTransaction.update).toHaveBeenCalledTimes(1);
  });

  it('fails closed for a wrong MessageSent emitter', async () => {
    const harness = legacyRecoveryHarness();
    harness.client.getTransactionReceipt.mockResolvedValue({
      status: 'success',
      from: WALLET,
      to: TOKEN_MESSENGER,
      logs: [
        {
          address: OTHER,
          topics: [],
          data: '0x',
        },
      ],
    });

    await expect(
      harness.service.getAttestation(OPERATION_ID, { walletAddress: WALLET }),
    ).rejects.toThrow('missing the expected MessageSent event');
  });

  it('fails closed for a reverted source receipt', async () => {
    const harness = legacyRecoveryHarness();
    harness.client.getTransactionReceipt.mockResolvedValue({
      status: 'reverted',
      from: WALLET,
      to: TOKEN_MESSENGER,
      logs: [],
    });

    await expect(
      harness.service.getAttestation(OPERATION_ID, { walletAddress: WALLET }),
    ).rejects.toThrow('signer, target, or status');
  });

  it('fails closed when the persisted message hash disagrees with the source event', async () => {
    const harness = legacyRecoveryHarness({
      sourceMessageHash: `0x${'44'.repeat(32)}`,
    });
    await expect(
      harness.service.getAttestation(OPERATION_ID, { walletAddress: WALLET }),
    ).rejects.toThrow('persisted source message hash does not match');
  });

  it('fails closed when the source RPC is not the persisted source chain', async () => {
    const harness = legacyRecoveryHarness();
    harness.client.getChainId.mockResolvedValue(11_155_111);
    await expect(
      harness.service.getAttestation(OPERATION_ID, { walletAddress: WALLET }),
    ).rejects.toThrow('not the configured expected chain');
  });

  it.each([
    ['source domain', { sourceDomain: 0 }],
    ['destination domain', { destinationDomain: 26 }],
    ['nonce', { nonce: padHex('0x99', { size: 32 }) }],
    ['sender', { sender: addressToBytes32(OTHER) }],
    ['recipient', { recipient: addressToBytes32(OTHER) }],
    ['amount', { amount: 2_000_000n }],
    ['finality threshold', { finalityThresholdExecuted: 1000 }],
  ])(
    'rejects a source message with the wrong %s binding',
    async (_field, override) => {
      const harness = legacyRecoveryHarness();
      harness.client.getTransactionReceipt.mockResolvedValue({
        status: 'success',
        from: WALLET,
        to: TOKEN_MESSENGER,
        logs: [
          {
            address: MESSAGE_TRANSMITTER,
            topics: encodeEventTopics({
              abi: CCTP_V2_MESSAGE_SENT_EVENT,
              eventName: 'MessageSent',
            }),
            data: encodeAbiParameters(
              [{ type: 'bytes' }],
              [cctpMessage(override)],
            ),
          },
        ],
      });

      await expect(
        harness.service.getAttestation(OPERATION_ID, { walletAddress: WALLET }),
      ).rejects.toThrow('source MessageSent event does not match');
    },
  );

  it('does not persist incomplete or mismatched Circle attestations', async () => {
    const pending = legacyRecoveryHarness();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ status: 'pending' }] }),
    } as Response);
    const pendingResponse = await pending.service.getAttestation(OPERATION_ID, {
      walletAddress: WALLET,
    });
    expect(pendingResponse.attestationStatus).toBe('pending');
    expect(pending.tx.bridgeTransaction.update).not.toHaveBeenCalled();

    const mismatch = legacyRecoveryHarness();
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        messages: [
          {
            status: 'complete',
            message: cctpMessage({
              nonce: padHex('0x99', { size: 32 }),
              finalityThresholdExecuted: 2000,
            }),
            attestation: `0x${'aa'.repeat(65)}`,
          },
        ],
      }),
    } as Response);
    await expect(
      mismatch.service.getAttestation(OPERATION_ID, { walletAddress: WALLET }),
    ).rejects.toThrow('nonce does not match');
    expect(mismatch.tx.bridgeTransaction.update).not.toHaveBeenCalled();
  });

  it('is idempotent for a modern intent that already has message and attestation', async () => {
    const harness = legacyRecoveryHarness({
      attestedMessage: harnessMessagePlaceholder(),
      messageHash: '0x' + '33'.repeat(32),
      attestation: '0x' + 'aa'.repeat(65),
    });
    const response = await harness.service.getAttestation(OPERATION_ID, {
      walletAddress: WALLET,
    });
    expect(response.attestationStatus).toBe('complete');
    expect(harness.client.getTransactionReceipt).not.toHaveBeenCalled();
    expect(harness.tx.bridgeTransaction.update).not.toHaveBeenCalled();
  });
});

function harnessMessagePlaceholder() {
  return cctpMessage();
}

describe('Bridge attestation field bindings', () => {
  it.each([
    ['domain', { sourceDomain: 0 }],
    ['nonce', { nonce: padHex('0x99', { size: 32 }) }],
    ['sender', { sender: getAddress(OTHER) }],
    ['recipient', { recipient: getAddress(OTHER) }],
    ['token', { burnToken: getAddress(OTHER) }],
    ['amount', { amount: 2_000_000n }],
    ['finality threshold', { finalityThresholdExecuted: 1000 }],
  ])('rejects the wrong %s', (_field, override) => {
    const decoded = decodeCctpV2Message(
      cctpMessage({
        nonce: padHex('0x1234', { size: 32 }),
        finalityThresholdExecuted: 2000,
      }),
    );
    const payload = legacyRecoveryHarness().existing
      .payload as unknown as BridgeIntentPayload;
    expect(
      matchesBridgeAttestation(
        payload,
        { ...decoded, ...override },
        decoded.nonce,
      ),
    ).toBe(false);
  });
});

describe('CCTP V2 destination completion', () => {
  const nonce = padHex('0x1234', { size: 32 });
  const message = cctpMessage({ nonce, finalityThresholdExecuted: 2000 });
  const messageBody = `0x${message.slice(2 + 148 * 2)}` as Hex;
  const expected = {
    caller: WALLET,
    sourceDomain: 26,
    nonce,
    sender: addressToBytes32(TOKEN_MESSENGER),
    finalityThresholdExecuted: 2000,
    messageBody,
  } as const;

  it.each([
    ['caller', { caller: OTHER }],
    ['domain', { sourceDomain: 0 }],
    ['nonce', { nonce: padHex('0x99', { size: 32 }) }],
    ['sender', { sender: addressToBytes32(OTHER) }],
    ['finality threshold', { finalityThresholdExecuted: 1000 }],
    ['message body', { messageBody: '0x1234' as Hex }],
  ])(
    'rejects a MessageReceived event with the wrong %s',
    (_field, override) => {
      expect(
        matchesCctpV2MessageReceived({ ...expected, ...override }, expected),
      ).toBe(false);
    },
  );

  it('strictly verifies receiveMessage calldata, receipt, nonce and USDC mint', async () => {
    const { service, operation, tx } = destinationHarness();
    const response = await (service as any).verifyAndComplete(
      operation,
      DESTINATION_HASH,
    );
    expect(response.status).toBe('completed');
    expect(response.result.destinationTransactionHash).toBe(DESTINATION_HASH);
    expect(tx.bridgeTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          destinationTransactionHash: DESTINATION_HASH,
        }),
      }),
    );
  });

  it('verifies EVM source to Arc using the native USDC system transfer', async () => {
    const { service, operation } = destinationHarness({ arcDestination: true });
    await expect(
      (service as any).verifyAndComplete(operation, DESTINATION_HASH),
    ).resolves.toMatchObject({ status: 'completed' });
  });

  it('prevents a second destination submission when the nonce is already used', async () => {
    const { service } = destinationHarness({ nonceUsed: 1n });
    await expect(
      service.authorizeDestination(OPERATION_ID, { walletAddress: WALLET }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'BRIDGE_MESSAGE_ALREADY_RECEIVED',
      }),
    });
  });

  it('returns the active destination lease idempotently', async () => {
    const { service, operation } = destinationHarness({ nonceUsed: 0n });
    Object.assign(operation, {
      destinationLeaseId: '33333333-3333-4333-8333-333333333333',
      destinationLeaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await expect(
      service.authorizeDestination(OPERATION_ID, { walletAddress: WALLET }),
    ).resolves.toMatchObject({
      leaseId: '33333333-3333-4333-8333-333333333333',
    });
  });

  it.each([
    ['reverted receipt', { receiptStatus: 'reverted' }],
    ['wrong contract', { receiptTo: OTHER }],
    ['wrong chain', { chainId: 5_042_002 }],
    [
      'wrong calldata message',
      {
        calldataMessage: cctpMessage({
          nonce: padHex('0x99', { size: 32 }),
          finalityThresholdExecuted: 2000,
        }),
      },
    ],
    ['wrong attestation', { calldataAttestation: `0x${'bb'.repeat(65)}` }],
    ['unused nonce', { nonceUsed: 0n }],
    ['missing USDC evidence', { omitTransfer: true }],
    ['wrong USDC emitter', { transferEmitter: OTHER }],
    ['wrong mint recipient', { transferRecipient: OTHER }],
  ])('fails closed for %s', async (_case, override) => {
    const { service, operation } = destinationHarness(override);
    await expect(
      (service as any).verifyAndComplete(operation, DESTINATION_HASH),
    ).rejects.toBeDefined();
  });
});

function destinationHarness(
  overrides: {
    receiptStatus?: 'success' | 'reverted';
    receiptTo?: string;
    chainId?: number;
    calldataMessage?: Hex;
    calldataAttestation?: Hex;
    nonceUsed?: bigint;
    omitTransfer?: boolean;
    transferEmitter?: string;
    transferRecipient?: string;
    arcDestination?: boolean;
  } = {},
) {
  const nonce = padHex('0x1234', { size: 32 });
  const message = cctpMessage({
    sourceDomain: overrides.arcDestination ? 0 : 26,
    destinationDomain: overrides.arcDestination ? 26 : 0,
    nonce,
    finalityThresholdExecuted: 2000,
    burnToken: overrides.arcDestination ? DESTINATION_USDC : SOURCE_USDC,
  });
  const attestation = `0x${'aa'.repeat(65)}` as Hex;
  const messageBody = `0x${message.slice(2 + 148 * 2)}` as Hex;
  const operation = {
    id: OPERATION_ID,
    taskId: '22222222-2222-4222-8222-222222222222',
    status: 'attestation_ready',
    payload: {
      ...request(
        overrides.arcDestination ? 'ETH-SEPOLIA' : 'ARC-TESTNET',
        overrides.arcDestination ? 'ARC-TESTNET' : 'ETH-SEPOLIA',
      ),
      sourceChainId: overrides.arcDestination ? 11_155_111 : 5_042_002,
      destinationChainId: overrides.arcDestination ? 5_042_002 : 11_155_111,
      sourceDomain: overrides.arcDestination ? 0 : 26,
      destinationDomain: overrides.arcDestination ? 26 : 0,
      sourceUsdcAddress: overrides.arcDestination
        ? DESTINATION_USDC
        : SOURCE_USDC,
      destinationUsdcAddress: overrides.arcDestination
        ? SOURCE_USDC
        : DESTINATION_USDC,
      sourceTokenMessengerV2: TOKEN_MESSENGER,
      sourceMessageTransmitterV2: MESSAGE_TRANSMITTER,
      destinationTokenMessengerV2: TOKEN_MESSENGER,
      destinationMessageTransmitterV2: MESSAGE_TRANSMITTER,
      destinationCaller: WALLET,
      createdAt: new Date().toISOString(),
    },
    result: {
      sourceTransactionHash: `0x${'11'.repeat(32)}`,
      messageHash: decodeCctpV2Message(message).messageHash,
      nonce,
      mintAmount: '1000000',
      attestedMessage: message,
      attestation,
    },
    messageHash: decodeCctpV2Message(message).messageHash,
    nonce,
    destinationTransactionHash: null,
    destinationLeaseId: null,
    destinationLeaseExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as unknown as BridgeTransaction;
  const transferLogs = overrides.omitTransfer
    ? []
    : [
        {
          address: (overrides.transferEmitter ??
            (overrides.arcDestination
              ? '0xfffffffffffffffffffffffffffffffffffffffe'
              : DESTINATION_USDC)) as `0x${string}`,
          topics: encodeEventTopics({
            abi: parseAbi([
              'event Transfer(address indexed from,address indexed to,uint256 value)',
            ]),
            eventName: 'Transfer',
            args: {
              from: '0x0000000000000000000000000000000000000000',
              to: (overrides.transferRecipient ?? WALLET) as `0x${string}`,
            },
          }),
          data: encodeAbiParameters(
            [{ type: 'uint256' }],
            [
              overrides.arcDestination
                ? 1_000_000_000_000_000_000n
                : 1_000_000n,
            ],
          ),
        },
      ];
  const receipt = {
    status: overrides.receiptStatus ?? 'success',
    from: WALLET,
    to: overrides.receiptTo ?? MESSAGE_TRANSMITTER,
    logs: [
      ...transferLogs,
      {
        address: MESSAGE_TRANSMITTER,
        topics: encodeEventTopics({
          abi: CCTP_V2_MESSAGE_RECEIVED_EVENT,
          eventName: 'MessageReceived',
          args: { caller: WALLET, nonce, finalityThresholdExecuted: 2000 },
        }),
        data: encodeAbiParameters(
          [{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }],
          [
            overrides.arcDestination ? 0 : 26,
            addressToBytes32(TOKEN_MESSENGER),
            messageBody,
          ],
        ),
      },
    ],
  };
  const client = {
    getChainId: jest
      .fn()
      .mockResolvedValue(
        overrides.chainId ??
          (overrides.arcDestination ? 5_042_002 : 11_155_111),
      ),
    getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
    getTransaction: jest.fn().mockResolvedValue({
      from: WALLET,
      to: MESSAGE_TRANSMITTER,
      input: encodeFunctionData({
        abi: parseAbi([
          'function receiveMessage(bytes message,bytes attestation) returns (bool)',
        ]),
        functionName: 'receiveMessage',
        args: [
          overrides.calldataMessage ?? message,
          overrides.calldataAttestation ?? attestation,
        ],
      }),
    }),
    readContract: jest.fn().mockResolvedValue(overrides.nonceUsed ?? 1n),
  };
  const tx = {
    bridgeTransaction: {
      update: jest
        .fn()
        .mockImplementation(({ data }) => ({ ...operation, ...data })),
    },
    task: { update: jest.fn() },
    taskLog: { create: jest.fn() },
  };
  const prisma = {
    bridgeTransaction: {
      findUnique: jest.fn().mockResolvedValue(operation),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn().mockImplementation((callback) => callback(tx)),
  };
  const service = new BridgeLifecycleService(prisma as never);
  (service as any).getClient = jest.fn().mockReturnValue(client);
  return { service, operation, tx, client, prisma };
}
