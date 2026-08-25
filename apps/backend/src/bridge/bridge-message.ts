import { BadRequestException } from '@nestjs/common';
import { getAddress, isHex, keccak256, type Address, type Hex } from 'viem';

const HEADER_LENGTH = 148;
const BURN_BODY_LENGTH = 228;

export interface DecodedCctpMessage {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  sender: Address;
  recipient: Address;
  destinationCaller: Address;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  burnVersion: number;
  burnToken: Address;
  mintRecipient: Address;
  amount: bigint;
  messageSender: Address;
  maxFee: bigint;
  feeExecuted: bigint;
  expirationBlock: bigint;
  messageHash: Hex;
}

function sliceBytes(message: Hex, offset: number, length: number): Hex {
  const start = 2 + offset * 2;
  return `0x${message.slice(start, start + length * 2)}`;
}

function readNumber(message: Hex, offset: number, length: number): number {
  return Number(BigInt(sliceBytes(message, offset, length)));
}

function readBigInt(message: Hex, offset: number, length: number): bigint {
  return BigInt(sliceBytes(message, offset, length));
}

function readAddress(message: Hex, offset: number): Address {
  const value = sliceBytes(message, offset, 32);
  return getAddress(`0x${value.slice(-40)}`);
}

export function addressToBytes32(address: Address): Hex {
  return `0x${address.toLowerCase().slice(2).padStart(64, '0')}`;
}

export function decodeCctpV2Message(message: Hex): DecodedCctpMessage {
  if (
    !isHex(message) ||
    (message.length - 2) / 2 < HEADER_LENGTH + BURN_BODY_LENGTH
  ) {
    throw new BadRequestException({
      code: 'BRIDGE_MESSAGE_INVALID',
      message: 'Circle returned an invalid or incomplete CCTP V2 message.',
    });
  }

  const bodyOffset = HEADER_LENGTH;
  return {
    version: readNumber(message, 0, 4),
    sourceDomain: readNumber(message, 4, 4),
    destinationDomain: readNumber(message, 8, 4),
    nonce: sliceBytes(message, 12, 32),
    sender: readAddress(message, 44),
    recipient: readAddress(message, 76),
    destinationCaller: readAddress(message, 108),
    minFinalityThreshold: readNumber(message, 140, 4),
    finalityThresholdExecuted: readNumber(message, 144, 4),
    burnVersion: readNumber(message, bodyOffset, 4),
    burnToken: readAddress(message, bodyOffset + 4),
    mintRecipient: readAddress(message, bodyOffset + 36),
    amount: readBigInt(message, bodyOffset + 68, 32),
    messageSender: readAddress(message, bodyOffset + 100),
    maxFee: readBigInt(message, bodyOffset + 132, 32),
    feeExecuted: readBigInt(message, bodyOffset + 164, 32),
    expirationBlock: readBigInt(message, bodyOffset + 196, 32),
    messageHash: keccak256(message),
  };
}
