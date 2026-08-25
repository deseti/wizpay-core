import {
  concatHex,
  decodeEventLog,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  numberToHex,
  padHex,
  type Address,
  type Hex,
} from 'viem';
import {
  CCTP_V2_DEPOSIT_EVENT,
  CCTP_V2_MESSAGE_RECEIVED_EVENT,
  matchesCctpV2MessageReceived,
} from './bridge-lifecycle.service';
import { addressToBytes32, decodeCctpV2Message } from './bridge-message';

const TOKEN_MESSENGER = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as Address;
const USDC = '0x3600000000000000000000000000000000000000' as Address;
const WALLET = '0x1111111111111111111111111111111111111111' as Address;
const OTHER = '0x2222222222222222222222222222222222222222' as Address;

function u32(value: number) {
  return numberToHex(value, { size: 4 });
}

function u256(value: bigint) {
  return numberToHex(value, { size: 32 });
}

function message(overrides?: {
  destinationDomain?: number;
  amount?: bigint;
}): Hex {
  const header = concatHex([
    u32(1),
    u32(26),
    u32(overrides?.destinationDomain ?? 6),
    padHex('0x1234', { size: 32 }),
    addressToBytes32(TOKEN_MESSENGER),
    addressToBytes32(TOKEN_MESSENGER),
    addressToBytes32(WALLET),
    u32(2000),
    u32(2000),
  ]);
  const body = concatHex([
    u32(1),
    addressToBytes32(USDC),
    addressToBytes32(WALLET),
    u256(overrides?.amount ?? 1_000_000n),
    addressToBytes32(WALLET),
    u256(1000n),
    u256(250n),
    u256(0n),
  ]);
  return concatHex([header, body]);
}

describe('decodeCctpV2Message', () => {
  it('decodes every security-relevant CCTP V2 field', () => {
    const decoded = decodeCctpV2Message(message());
    expect(decoded).toMatchObject({
      version: 1,
      sourceDomain: 26,
      destinationDomain: 6,
      sender: TOKEN_MESSENGER,
      recipient: TOKEN_MESSENGER,
      destinationCaller: WALLET,
      minFinalityThreshold: 2000,
      finalityThresholdExecuted: 2000,
      burnVersion: 1,
      burnToken: USDC,
      mintRecipient: WALLET,
      amount: 1_000_000n,
      messageSender: WALLET,
      maxFee: 1000n,
      feeExecuted: 250n,
      expirationBlock: 0n,
    });
    expect(decoded.messageHash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('rejects truncated messages', () => {
    expect(() => decodeCctpV2Message('0x1234')).toThrow(
      'invalid or incomplete',
    );
  });
});

describe('CCTP V2 source event ABI', () => {
  it('decodes the current TokenMessengerV2 DepositForBurn layout', () => {
    const burnToken = getAddress(USDC);
    const depositor = getAddress(WALLET);
    const mintRecipient = addressToBytes32(depositor);
    const destinationMessenger = addressToBytes32(getAddress(TOKEN_MESSENGER));
    const destinationCaller = addressToBytes32(depositor);
    const topics = encodeEventTopics({
      abi: CCTP_V2_DEPOSIT_EVENT,
      eventName: 'DepositForBurn',
      args: [burnToken, depositor, 2000],
    });
    const data = encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'uint32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'bytes' },
      ],
      [
        10_000_000n,
        mintRecipient,
        0,
        destinationMessenger,
        destinationCaller,
        0n,
        '0x',
      ],
    );
    const decoded = decodeEventLog({
      abi: CCTP_V2_DEPOSIT_EVENT,
      eventName: 'DepositForBurn',
      data,
      topics,
    });

    expect(decoded.args).toMatchObject({
      burnToken,
      depositor,
      amount: 10_000_000n,
      destinationDomain: 0,
      minFinalityThreshold: 2000,
      hookData: '0x',
    });
  });
});

describe('CCTP V2 MessageReceived event ABI', () => {
  const caller = getAddress(WALLET);
  const nonce = padHex('0x1234', { size: 32 });
  const sender = addressToBytes32(getAddress(TOKEN_MESSENGER));
  const messageBody = '0x01020304' as Hex;
  const topics = encodeEventTopics({
    abi: CCTP_V2_MESSAGE_RECEIVED_EVENT,
    eventName: 'MessageReceived',
    args: [caller, nonce, 2000],
  });
  const data = encodeAbiParameters(
    [{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }],
    [26, sender, messageBody],
  );
  const decoded = decodeEventLog({
    abi: CCTP_V2_MESSAGE_RECEIVED_EVENT,
    eventName: 'MessageReceived',
    data,
    topics,
  });
  const expected = {
    caller,
    sourceDomain: 26,
    nonce,
    sender,
    finalityThresholdExecuted: 2000,
    messageBody,
  };

  it('decodes the current V2 indexed and data fields', () => {
    expect(decoded.args).toEqual({
      caller,
      sourceDomain: 26,
      nonce,
      sender,
      finalityThresholdExecuted: 2000,
      messageBody,
    });
    expect(matchesCctpV2MessageReceived(decoded.args, expected)).toBe(true);
  });

  it.each([
    ['caller', { caller: getAddress(OTHER) }],
    ['source domain', { sourceDomain: 0 }],
    ['nonce', { nonce: padHex('0x99', { size: 32 }) }],
    ['sender', { sender: addressToBytes32(getAddress(OTHER)) }],
    ['finality threshold', { finalityThresholdExecuted: 1000 }],
    ['message body', { messageBody: '0xffff' }],
  ])('rejects a mismatched %s', (_field, override) => {
    expect(
      matchesCctpV2MessageReceived({ ...decoded.args, ...override }, expected),
    ).toBe(false);
  });
});
