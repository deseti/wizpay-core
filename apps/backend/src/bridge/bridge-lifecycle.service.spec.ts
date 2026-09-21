import { ServiceUnavailableException } from '@nestjs/common';
import {
  concatHex,
  numberToHex,
  padHex,
  type Hex,
} from 'viem';
import {
  BridgeLifecycleService,
  bridgeUnavailable,
  matchesBridgeAttestation,
  matchesBridgeSourceMessage,
  matchesCctpV2MessageReceived,
  matchesExpectedDestinationChain,
  type BridgeIntentPayload,
} from './bridge-lifecycle.service';
import { addressToBytes32, decodeCctpV2Message } from './bridge-message';

const WALLET = '0x1111111111111111111111111111111111111111' as const;
const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as const;
const SOURCE_USDC = '0x3600000000000000000000000000000000000000' as const;
const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

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
    addressToBytes32(TOKEN_MESSENGER),
    addressToBytes32(TOKEN_MESSENGER),
    addressToBytes32(WALLET),
    u32(2000),
    u32(overrides.finalityThresholdExecuted ?? 0),
    u32(1),
    addressToBytes32(SOURCE_USDC),
    addressToBytes32(WALLET),
    u256(overrides.amount ?? 1_000_000n),
    addressToBytes32(WALLET),
    u256(1000n),
    u256(0n),
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
    sourceUsdcAddress: SOURCE_USDC,
    destinationUsdcAddress: SOURCE_USDC,
    sourceTokenMessengerV2: TOKEN_MESSENGER,
    destinationTokenMessengerV2: TOKEN_MESSENGER,
    destinationMessageTransmitterV2: TOKEN_MESSENGER,
    walletAddress: WALLET,
    recipientAddress: WALLET,
    destinationCaller: WALLET,
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
    destinationCode: 'ARC-MAINNET',
    walletAddress: WALLET,
    recipientAddress: WALLET,
    amount: '1000000',
    maxFee: '1000',
    minFinalityThreshold: 2000,
  };
}

describe('BridgeLifecycleService is fail-closed on Arc Mainnet', () => {
  const service = new BridgeLifecycleService();

  it('exposes the unavailable error with BRIDGE_UNAVAILABLE', () => {
    expect(bridgeUnavailable()).toBeInstanceOf(ServiceUnavailableException);
    expect(bridgeUnavailable().getResponse()).toMatchObject({
      code: 'BRIDGE_UNAVAILABLE',
    });
  });

  it.each([
    ['createIntent', [request()]],
    ['getIntent', [OPERATION_ID, { walletAddress: WALLET }]],
    [
      'reportApproval',
      [OPERATION_ID, { walletAddress: WALLET, transactionHash: `0x${'11'.repeat(32)}` }],
    ],
    [
      'reportSource',
      [OPERATION_ID, { walletAddress: WALLET, transactionHash: `0x${'11'.repeat(32)}` }],
    ],
    ['getAttestation', [OPERATION_ID, { walletAddress: WALLET }]],
    ['reattest', [OPERATION_ID, { walletAddress: WALLET }]],
    [
      'reportDestination',
      [
        OPERATION_ID,
        {
          walletAddress: WALLET,
          transactionHash: `0x${'11'.repeat(32)}`,
          messageHash: `0x${'22'.repeat(32)}`,
        },
      ],
    ],
    ['authorizeDestination', [OPERATION_ID, { walletAddress: WALLET }]],
    [
      'submitDestination',
      [
        OPERATION_ID,
        {
          walletAddress: WALLET,
          transactionHash: `0x${'11'.repeat(32)}`,
          messageHash: `0x${'22'.repeat(32)}`,
          leaseId: OPERATION_ID,
        },
      ],
    ],
    ['verifyDestination', [OPERATION_ID, { walletAddress: WALLET }]],
  ])('fails closed for %s without side effects', async (method, args) => {
    await expect(
      (service as unknown as Record<string, (...call: never[]) => unknown>)[
        method
      ](...(args as never[])),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'BRIDGE_UNAVAILABLE' }),
    });
  });
});

describe('Bridge codec matchers', () => {
  it('matches identical destination chains and rejects mismatches', () => {
    expect(matchesExpectedDestinationChain(5042, 5042)).toBe(true);
    expect(matchesExpectedDestinationChain(11155111, 5042)).toBe(false);
  });

  it('matches a canonical source message with zero finality executed', () => {
    const decoded = decodeCctpV2Message(
      cctpMessage({ destinationDomain: 26 }),
    );
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
      matchesBridgeAttestation(candidate, decoded, padHex('0x99', { size: 32 })),
    ).toBe(false);
  });

  it('matches received-event bindings exactly', () => {
    const nonce = padHex('0x1234', { size: 32 });
    const args = {
      caller: WALLET,
      sourceDomain: 26,
      nonce,
      sender: addressToBytes32(TOKEN_MESSENGER),
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
