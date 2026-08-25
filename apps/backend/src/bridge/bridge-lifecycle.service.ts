import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type BridgeTransaction } from '@prisma/client';
import {
  BRIDGE_TESTNET_BY_CODE,
  CCTP_V2_TESTNET_IRIS_BASE_URL,
  assertBridgeRoute,
  type BridgeTestnetCode,
} from '@wizpay/bridge-registry';
import {
  createPublicClient,
  decodeFunctionData,
  decodeEventLog,
  getAddress,
  http,
  isAddressEqual,
  isHex,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { PrismaService } from '../database/prisma.service';
import {
  BridgeWalletDto,
  CreateBridgeIntentDto,
  ReportBridgeApprovalDto,
  SubmitBridgeDestinationDto,
  ReportBridgeDestinationDto,
  ReportBridgeSourceDto,
} from './dto/bridge-intent.dto';
import { addressToBytes32, decodeCctpV2Message } from './bridge-message';

const DESTINATION_LEASE_MS = 5 * 60 * 1000;

const APPROVAL_EVENT = parseAbi([
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
]);
export const CCTP_V2_DEPOSIT_EVENT = parseAbi([
  'event DepositForBurn(address indexed burnToken,uint256 amount,address indexed depositor,bytes32 mintRecipient,uint32 destinationDomain,bytes32 destinationTokenMessenger,bytes32 destinationCaller,uint256 maxFee,uint32 indexed minFinalityThreshold,bytes hookData)',
]);
export const CCTP_V2_MESSAGE_RECEIVED_EVENT = parseAbi([
  'event MessageReceived(address indexed caller,uint32 sourceDomain,bytes32 indexed nonce,bytes32 sender,uint32 indexed finalityThresholdExecuted,bytes messageBody)',
]);
export const CCTP_V2_MESSAGE_SENT_EVENT = parseAbi([
  'event MessageSent(bytes message)',
]);

export function matchesCctpV2MessageReceived(
  args: Record<string, unknown>,
  expected: {
    caller: Address;
    sourceDomain: number;
    nonce: Hex;
    sender: Hex;
    finalityThresholdExecuted: number;
    messageBody: Hex;
  },
) {
  return (
    isAddressEqual(args.caller as Address, expected.caller) &&
    args.sourceDomain === expected.sourceDomain &&
    (args.nonce as Hex).toLowerCase() === expected.nonce.toLowerCase() &&
    (args.sender as Hex).toLowerCase() === expected.sender.toLowerCase() &&
    args.finalityThresholdExecuted === expected.finalityThresholdExecuted &&
    (args.messageBody as Hex).toLowerCase() ===
      expected.messageBody.toLowerCase()
  );
}

export function matchesExpectedDestinationChain(
  actualChainId: number,
  expectedChainId: number,
) {
  return actualChainId === expectedChainId;
}

export function matchesBridgeAttestation(
  payload: BridgeIntentPayload,
  decoded: ReturnType<typeof decodeCctpV2Message>,
  expectedNonce?: Hex,
) {
  return (
    decoded.version === 1 &&
    decoded.burnVersion === 1 &&
    decoded.sourceDomain === payload.sourceDomain &&
    decoded.destinationDomain === payload.destinationDomain &&
    (!expectedNonce ||
      decoded.nonce.toLowerCase() === expectedNonce.toLowerCase()) &&
    decoded.finalityThresholdExecuted === payload.minFinalityThreshold &&
    isAddressEqual(decoded.sender, payload.sourceTokenMessengerV2) &&
    isAddressEqual(decoded.recipient, payload.destinationTokenMessengerV2) &&
    isAddressEqual(decoded.destinationCaller, payload.destinationCaller) &&
    decoded.minFinalityThreshold === payload.minFinalityThreshold &&
    isAddressEqual(decoded.burnToken, payload.sourceUsdcAddress) &&
    isAddressEqual(decoded.mintRecipient, payload.recipientAddress) &&
    isAddressEqual(decoded.messageSender, payload.walletAddress) &&
    decoded.amount === BigInt(payload.amount) &&
    decoded.maxFee === BigInt(payload.maxFee) &&
    decoded.feeExecuted <= decoded.maxFee &&
    decoded.feeExecuted < decoded.amount
  );
}

export function matchesBridgeSourceMessage(
  payload: BridgeIntentPayload,
  decoded: ReturnType<typeof decodeCctpV2Message>,
) {
  return (
    decoded.version === 1 &&
    decoded.sourceDomain === payload.sourceDomain &&
    decoded.destinationDomain === payload.destinationDomain &&
    decoded.nonce === `0x${'00'.repeat(32)}` &&
    decoded.finalityThresholdExecuted === 0 &&
    decoded.burnVersion === 1 &&
    decoded.minFinalityThreshold === payload.minFinalityThreshold &&
    isAddressEqual(decoded.sender, payload.sourceTokenMessengerV2) &&
    isAddressEqual(decoded.recipient, payload.destinationTokenMessengerV2) &&
    isAddressEqual(decoded.destinationCaller, payload.destinationCaller) &&
    isAddressEqual(decoded.burnToken, payload.sourceUsdcAddress) &&
    isAddressEqual(decoded.mintRecipient, payload.recipientAddress) &&
    isAddressEqual(decoded.messageSender, payload.walletAddress) &&
    decoded.amount === BigInt(payload.amount) &&
    decoded.maxFee === BigInt(payload.maxFee) &&
    decoded.feeExecuted === 0n
  );
}
const RECEIVE_MESSAGE_ABI = parseAbi([
  'function receiveMessage(bytes message, bytes attestation) external returns (bool)',
]);
const USED_NONCES_ABI = parseAbi([
  'function usedNonces(bytes32 nonce) view returns (uint256)',
]);
const USDC_TRANSFER_EVENT = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);

export type BridgeLifecycleStatus =
  | 'idle'
  | 'approving_source'
  | 'approval_confirmed'
  | 'source_approved'
  | 'burning_source'
  | 'source_confirmed'
  | 'source_burn_confirmed'
  | 'waiting_for_attestation'
  | 'attestation_ready'
  | 'switching_destination_chain'
  | 'awaiting_destination_signature'
  | 'minting_destination'
  | 'verifying_destination'
  | 'source_rejected'
  | 'source_failed_before_burn'
  | 'attestation_delayed'
  | 'destination_signature_rejected'
  | 'destination_transaction_failed'
  | 'destination_verification_failed'
  | 'configuration_error'
  | 'completed';

export interface BridgeIntentPayload {
  idempotencyKey: string;
  sourceCode: BridgeTestnetCode;
  destinationCode: BridgeTestnetCode;
  sourceChainId: number;
  destinationChainId: number;
  sourceDomain: number;
  destinationDomain: number;
  sourceUsdcAddress: Address;
  destinationUsdcAddress: Address;
  destinationMintEvidenceEmitter?: Address;
  destinationMintEvidenceDecimals?: 6 | 18;
  sourceTokenMessengerV2: Address;
  sourceMessageTransmitterV2?: Address;
  destinationTokenMessengerV2: Address;
  destinationMessageTransmitterV2: Address;
  walletAddress: Address;
  recipientAddress: Address;
  destinationCaller: Address;
  amount: string;
  maxFee: string;
  minFinalityThreshold: 2000;
  createdAt: string;
}

export interface BridgeLifecycleResult {
  approvalTransactionHash?: Hex;
  sourceTransactionHash?: Hex;
  destinationTransactionHash?: Hex;
  messageHash?: Hex;
  nonce?: Hex;
  feeExecuted?: string;
  mintAmount?: string;
  expirationBlock?: string;
  attestedMessage?: Hex;
  attestation?: Hex;
  sourceMessageHash?: Hex;
  completedAt?: string;
  destinationSubmittedAt?: string;
}

@Injectable()
export class BridgeLifecycleService {
  private readonly clients = new Map<BridgeTestnetCode, PublicClient>();

  constructor(private readonly prisma: PrismaService) {}

  async createIntent(input: CreateBridgeIntentDto) {
    const { source, destination } = this.getRoute(
      input.sourceCode,
      input.destinationCode,
    );
    const amount = this.positiveUint(input.amount, 'amount');
    const maxFee = this.uint(input.maxFee, 'maxFee');
    if (maxFee >= amount) {
      this.invalid(
        'BRIDGE_FEE_INVALID',
        'The CCTP maximum fee must be lower than the transfer amount.',
      );
    }

    const walletAddress = getAddress(input.walletAddress);
    const recipientAddress = getAddress(input.recipientAddress);
    if (!isAddressEqual(walletAddress, recipientAddress)) {
      this.invalid(
        'BRIDGE_RECIPIENT_MISMATCH',
        'Bridge recipient must be the connected external wallet for this release.',
      );
    }

    const payload: BridgeIntentPayload = {
      idempotencyKey: input.idempotencyKey,
      sourceCode: source.code,
      destinationCode: destination.code,
      sourceChainId: source.chainId,
      destinationChainId: destination.chainId,
      sourceDomain: source.cctpDomain,
      destinationDomain: destination.cctpDomain,
      sourceUsdcAddress: getAddress(source.usdcAddress),
      destinationUsdcAddress: getAddress(destination.usdcAddress),
      destinationMintEvidenceEmitter: getAddress(
        destination.mintEvidenceEmitter,
      ),
      destinationMintEvidenceDecimals: destination.mintEvidenceDecimals,
      sourceTokenMessengerV2: getAddress(source.tokenMessengerV2),
      sourceMessageTransmitterV2: getAddress(source.messageTransmitterV2),
      destinationTokenMessengerV2: getAddress(destination.tokenMessengerV2),
      destinationMessageTransmitterV2: getAddress(
        destination.messageTransmitterV2,
      ),
      walletAddress,
      recipientAddress,
      destinationCaller: walletAddress,
      amount: amount.toString(),
      maxFee: maxFee.toString(),
      minFinalityThreshold: 2000,
      createdAt: new Date().toISOString(),
    };

    const existing = await this.prisma.bridgeTransaction.findUnique({
      where: { id: input.idempotencyKey },
    });
    if (existing) {
      this.assertSameIntent(existing, payload);
      return this.toResponse(existing);
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const task = await tx.task.create({
          data: {
            type: 'bridge',
            status: 'in_progress',
            payload: payload as unknown as Prisma.InputJsonValue,
            metadata: {
              walletAddress: walletAddress.toLowerCase(),
              sourceCode: source.code,
              destinationCode: destination.code,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        await tx.taskLog.create({
          data: {
            taskId: task.id,
            step: 'bridge.idle',
            status: 'in_progress',
            message: 'Non-custodial external-wallet CCTP intent created.',
          },
        });
        return tx.bridgeTransaction.create({
          data: {
            id: input.idempotencyKey,
            taskId: task.id,
            status: 'idle',
            payload: payload as unknown as Prisma.InputJsonValue,
            result: {},
          },
        });
      });
      return this.toResponse(created);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const concurrent = await this.prisma.bridgeTransaction.findUnique({
          where: { id: input.idempotencyKey },
        });
        if (concurrent) {
          this.assertSameIntent(concurrent, payload);
          return this.toResponse(concurrent);
        }
      }
      throw error;
    }
  }

  async getIntent(id: string, input: BridgeWalletDto) {
    const operation = await this.getOwned(id, input.walletAddress);
    const result = this.result(operation);
    if (operation.status === 'completed') return this.toResponse(operation);
    if (!result.nonce || !result.attestedMessage || !result.attestation) {
      return { ...this.toResponse(operation), destinationState: 'not_ready' };
    }
    try {
      const used = await this.isNonceUsed(
        this.payload(operation),
        result.nonce,
      );
      return {
        ...this.toResponse(operation),
        destinationState: used ? 'received' : 'available',
      };
    } catch {
      return { ...this.toResponse(operation), destinationState: 'unknown' };
    }
  }

  async reportApproval(id: string, input: ReportBridgeApprovalDto) {
    const operation = await this.getOwned(id, input.walletAddress);
    const payload = this.payload(operation);
    const result = this.result(operation);
    if (result.approvalTransactionHash) {
      if (
        result.approvalTransactionHash.toLowerCase() !==
        input.transactionHash.toLowerCase()
      ) {
        throw new ConflictException(
          'A different approval transaction is already bound to this bridge intent.',
        );
      }
      return this.toResponse(operation);
    }
    if (result.sourceTransactionHash) {
      throw new ConflictException(
        'The source burn is already confirmed; approval cannot be changed.',
      );
    }

    const receipt = await this.receipt(
      payload.sourceCode,
      input.transactionHash as Hex,
      payload.sourceChainId,
    );
    this.assertSuccessfulReceipt(
      receipt,
      payload.walletAddress,
      payload.sourceUsdcAddress,
    );
    const approval = this.decodeMatchingLog(
      receipt.logs,
      APPROVAL_EVENT,
      'Approval',
      payload.sourceUsdcAddress,
    );
    if (
      !isAddressEqual(approval.args.owner as Address, payload.walletAddress) ||
      !isAddressEqual(
        approval.args.spender as Address,
        payload.sourceTokenMessengerV2,
      ) ||
      BigInt(approval.args.value as bigint) < BigInt(payload.amount)
    ) {
      this.invalid(
        'BRIDGE_APPROVAL_MISMATCH',
        'The confirmed approval does not authorize this exact CCTP intent.',
      );
    }
    return this.update(operation, 'source_approved', {
      ...result,
      approvalTransactionHash: input.transactionHash as Hex,
    });
  }

  async reportSource(id: string, input: ReportBridgeSourceDto) {
    const operation = await this.getOwned(id, input.walletAddress);
    const payload = this.payload(operation);
    const result = this.result(operation);
    if (result.sourceTransactionHash) {
      if (
        result.sourceTransactionHash.toLowerCase() !==
        input.transactionHash.toLowerCase()
      ) {
        throw new ConflictException(
          'A different source burn is already bound to this bridge intent.',
        );
      }
      return this.toResponse(operation);
    }

    const receipt = await this.receipt(
      payload.sourceCode,
      input.transactionHash as Hex,
      payload.sourceChainId,
    );
    this.assertSuccessfulReceipt(
      receipt,
      payload.walletAddress,
      payload.sourceTokenMessengerV2,
    );
    const deposit = this.decodeMatchingLog(
      receipt.logs,
      CCTP_V2_DEPOSIT_EVENT,
      'DepositForBurn',
      payload.sourceTokenMessengerV2,
    );
    const expectedRecipient = addressToBytes32(payload.recipientAddress);
    const expectedCaller = addressToBytes32(payload.destinationCaller);
    const expectedDestinationMessenger = addressToBytes32(
      payload.destinationTokenMessengerV2,
    );
    if (
      !isAddressEqual(
        deposit.args.burnToken as Address,
        payload.sourceUsdcAddress,
      ) ||
      !isAddressEqual(
        deposit.args.depositor as Address,
        payload.walletAddress,
      ) ||
      deposit.args.amount !== BigInt(payload.amount) ||
      deposit.args.destinationDomain !== payload.destinationDomain ||
      (deposit.args.mintRecipient as Hex).toLowerCase() !==
        expectedRecipient.toLowerCase() ||
      (deposit.args.destinationCaller as Hex).toLowerCase() !==
        expectedCaller.toLowerCase() ||
      (deposit.args.destinationTokenMessenger as Hex).toLowerCase() !==
        expectedDestinationMessenger.toLowerCase() ||
      deposit.args.maxFee !== BigInt(payload.maxFee) ||
      deposit.args.minFinalityThreshold !== payload.minFinalityThreshold ||
      deposit.args.hookData !== '0x'
    ) {
      this.invalid(
        'BRIDGE_SOURCE_MISMATCH',
        'The confirmed CCTP burn does not match the persisted bridge intent.',
      );
    }
    await this.assertResultValueUnused(
      operation.id,
      'sourceTransactionHash',
      input.transactionHash,
      'This CCTP burn is already bound to another bridge intent.',
    );

    return this.update(operation, 'source_burn_confirmed', {
      ...result,
      sourceTransactionHash: input.transactionHash as Hex,
    });
  }

  async getAttestation(id: string, input: BridgeWalletDto) {
    const operation = await this.getOwned(id, input.walletAddress);
    const payload = this.payload(operation);
    const result = this.result(operation);
    if (!result.sourceTransactionHash) {
      this.invalid(
        'BRIDGE_SOURCE_REQUIRED',
        'Confirm the source burn before requesting an attestation.',
      );
    }

    if (result.attestedMessage && result.attestation && result.messageHash) {
      return {
        ...this.toResponse(operation),
        attestationStatus: 'complete',
        message: result.attestedMessage,
        attestation: result.attestation,
      };
    }

    const recovered = await this.recoverSourceMessage(payload, result);
    if (
      result.attestedMessage &&
      result.attestedMessage.toLowerCase() !== recovered.message.toLowerCase()
    ) {
      this.invalid(
        'BRIDGE_MESSAGE_MISMATCH',
        'The persisted attested message does not match the source receipt.',
      );
    }
    const url = `${this.irisBaseUrl()}/messages/${payload.sourceDomain}?transactionHash=${result.sourceTransactionHash}`;
    let response: Response;
    try {
      response = await fetch(url, { headers: { accept: 'application/json' } });
    } catch {
      throw new BadGatewayException(
        'Circle attestation service is temporarily unavailable. Retry without submitting another burn.',
      );
    }
    if (!response.ok) {
      throw new BadGatewayException(
        `Circle attestation service returned HTTP ${response.status}.`,
      );
    }
    const body = (await response.json()) as {
      messages?: Array<{
        status?: string;
        message?: string;
        attestation?: string;
      }>;
    };
    const item = body.messages?.[0];
    if (!item || item.status !== 'complete') {
      return {
        ...this.toResponse(operation),
        attestationStatus: item?.status ?? 'pending',
      };
    }
    if (
      !isHex(item.message) ||
      !isHex(item.attestation) ||
      item.attestation === '0x'
    ) {
      throw new BadGatewayException(
        'Circle returned an incomplete CCTP attestation payload.',
      );
    }

    if (keccak256(item.message) === recovered.messageHash) {
      this.invalid(
        'BRIDGE_ATTESTATION_MISMATCH',
        'Circle returned the pre-attestation source message instead of the canonical attested message.',
      );
    }

    const decoded = decodeCctpV2Message(item.message);
    this.assertAttestedMessage(payload, decoded);
    if (
      result.nonce &&
      result.nonce.toLowerCase() !== decoded.nonce.toLowerCase()
    ) {
      this.invalid(
        'BRIDGE_NONCE_MISMATCH',
        'The attested CCTP nonce does not match the verified lifecycle.',
      );
    }
    if (
      decoded.sourceDomain !== recovered.sourceDecoded.sourceDomain ||
      decoded.destinationDomain !== recovered.sourceDecoded.destinationDomain ||
      decoded.sender.toLowerCase() !==
        recovered.sourceDecoded.sender.toLowerCase() ||
      decoded.recipient.toLowerCase() !==
        recovered.sourceDecoded.recipient.toLowerCase() ||
      decoded.destinationCaller.toLowerCase() !==
        recovered.sourceDecoded.destinationCaller.toLowerCase() ||
      decoded.minFinalityThreshold !==
        recovered.sourceDecoded.minFinalityThreshold ||
      decoded.burnToken.toLowerCase() !==
        recovered.sourceDecoded.burnToken.toLowerCase() ||
      decoded.mintRecipient.toLowerCase() !==
        recovered.sourceDecoded.mintRecipient.toLowerCase() ||
      decoded.amount !== recovered.sourceDecoded.amount ||
      decoded.messageSender.toLowerCase() !==
        recovered.sourceDecoded.messageSender.toLowerCase() ||
      decoded.maxFee !== recovered.sourceDecoded.maxFee ||
      item.message.slice(2 + 148 * 2).toLowerCase() !==
        recovered.message.slice(2 + 148 * 2).toLowerCase()
    ) {
      this.invalid(
        'BRIDGE_ATTESTATION_MISMATCH',
        'Circle returned a message with bindings different from the source MessageSent event.',
      );
    }
    const nextResult: BridgeLifecycleResult = {
      ...result,
      messageHash: decoded.messageHash,
      sourceMessageHash: recovered.messageHash,
      attestedMessage: item.message,
      attestation: item.attestation,
      nonce: decoded.nonce,
      feeExecuted: decoded.feeExecuted.toString(),
      mintAmount: (decoded.amount - decoded.feeExecuted).toString(),
      expirationBlock: decoded.expirationBlock.toString(),
    };
    await this.assertResultValueUnused(
      operation.id,
      'nonce',
      decoded.nonce,
      'This CCTP nonce is already bound to another bridge intent.',
    );
    await this.assertResultValueUnused(
      operation.id,
      'messageHash',
      decoded.messageHash,
      'This CCTP message is already bound to another bridge intent.',
    );
    const updated = await this.update(
      operation,
      'attestation_ready',
      nextResult,
    );
    return {
      ...updated,
      attestationStatus: 'complete',
      message: item.message,
      attestation: item.attestation,
    };
  }

  async reattest(id: string, input: BridgeWalletDto) {
    const operation = await this.getOwned(id, input.walletAddress);
    const result = this.result(operation);
    if (!result.nonce || !result.sourceTransactionHash) {
      this.invalid(
        'BRIDGE_REATTEST_UNAVAILABLE',
        'A verified CCTP nonce is required before re-attestation.',
      );
    }
    const response = await fetch(
      `${this.irisBaseUrl()}/reattest/${result.nonce}`,
      {
        method: 'POST',
        headers: { accept: 'application/json' },
      },
    );
    if (!response.ok) {
      throw new BadGatewayException(
        `Circle re-attestation returned HTTP ${response.status}.`,
      );
    }
    return {
      ...this.toResponse(operation),
      attestationStatus: 'reattest_requested',
    };
  }

  async reportDestination(id: string, input: ReportBridgeDestinationDto) {
    const operation = await this.getOwned(id, input.walletAddress);
    if (operation.status === 'completed') {
      const existing = this.result(operation).destinationTransactionHash;
      if (existing?.toLowerCase() !== input.transactionHash.toLowerCase()) {
        throw new ConflictException(
          'A different destination transaction is already bound to this bridge intent.',
        );
      }
      return this.toResponse(operation);
    }
    this.assertDestinationMessage(operation, input.messageHash as Hex);
    return this.verifyAndComplete(operation, input.transactionHash as Hex);
  }

  async authorizeDestination(id: string, input: BridgeWalletDto) {
    let operation = await this.getOwned(id, input.walletAddress);
    if (
      operation.status === 'completed' ||
      operation.destinationTransactionHash
    ) {
      return this.toResponse(operation);
    }
    const result = this.result(operation);
    this.requireAttestation(result);
    if (await this.isNonceUsed(this.payload(operation), result.nonce!)) {
      this.invalid(
        'BRIDGE_MESSAGE_ALREADY_RECEIVED',
        'This CCTP message is already received on-chain and requires strict receipt reconciliation, not another wallet transaction.',
      );
    }
    const now = new Date();
    if (
      operation.destinationLeaseId &&
      operation.destinationLeaseExpiresAt &&
      operation.destinationLeaseExpiresAt > now
    ) {
      return {
        ...this.toResponse(operation),
        leaseId: operation.destinationLeaseId,
      };
    }
    const leaseId = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + DESTINATION_LEASE_MS);
    const claimed = await this.prisma.bridgeTransaction.updateMany({
      where: {
        id: operation.id,
        destinationTransactionHash: null,
        OR: [
          { destinationLeaseId: null },
          { destinationLeaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        status: 'awaiting_destination_signature',
        destinationLeaseId: leaseId,
        destinationLeaseExpiresAt: leaseExpiresAt,
      },
    });
    operation = await this.getOwned(id, input.walletAddress);
    if (claimed.count !== 1 && operation.destinationLeaseId !== leaseId) {
      throw new ConflictException({
        code: 'BRIDGE_DESTINATION_SUBMISSION_ACTIVE',
        message:
          'A destination wallet authorization is already active for this CCTP message.',
      });
    }
    return {
      ...this.toResponse(operation),
      leaseId: operation.destinationLeaseId,
    };
  }

  async submitDestination(id: string, input: SubmitBridgeDestinationDto) {
    let operation = await this.getOwned(id, input.walletAddress);
    this.assertDestinationMessage(operation, input.messageHash as Hex);
    if (operation.destinationTransactionHash) {
      if (
        operation.destinationTransactionHash.toLowerCase() !==
        input.transactionHash.toLowerCase()
      ) {
        throw new ConflictException(
          'A different destination transaction is already bound to this bridge intent.',
        );
      }
      return this.toResponse(operation);
    }
    const claimed = await this.prisma.bridgeTransaction.updateMany({
      where: {
        id: operation.id,
        destinationTransactionHash: null,
        destinationLeaseId: input.leaseId,
        destinationLeaseExpiresAt: { gt: new Date() },
      },
      data: {
        status: 'minting_destination',
        destinationTransactionHash: input.transactionHash.toLowerCase(),
        destinationLeaseId: null,
        destinationLeaseExpiresAt: null,
        result: {
          ...this.result(operation),
          destinationTransactionHash: input.transactionHash,
          destinationSubmittedAt: new Date().toISOString(),
        },
      },
    });
    operation = await this.getOwned(id, input.walletAddress);
    if (claimed.count !== 1) {
      throw new ConflictException({
        code: 'BRIDGE_DESTINATION_LEASE_INVALID',
        message:
          'Destination authorization expired or no longer owns this message.',
      });
    }
    return this.toResponse(operation);
  }

  async verifyDestination(id: string, input: BridgeWalletDto) {
    const operation = await this.getOwned(id, input.walletAddress);
    if (operation.status === 'completed') return this.toResponse(operation);
    const hash = operation.destinationTransactionHash as Hex | null;
    if (!hash) {
      this.invalid(
        'BRIDGE_DESTINATION_TRANSACTION_REQUIRED',
        'No destination transaction is bound to this bridge intent.',
      );
    }
    return this.verifyAndComplete(operation, hash);
  }

  private assertDestinationMessage(
    operation: BridgeTransaction,
    messageHash: Hex,
  ) {
    const payload = this.payload(operation);
    const result = this.result(operation);
    if (
      !result.messageHash ||
      result.messageHash.toLowerCase() !== messageHash.toLowerCase()
    ) {
      this.invalid(
        'BRIDGE_MESSAGE_HASH_MISMATCH',
        'Destination mint does not match the verified CCTP message.',
      );
    }
    this.requireAttestation(result);
    this.assertAttestedMessage(
      payload,
      decodeCctpV2Message(result.attestedMessage!),
    );
  }

  private async verifyAndComplete(
    operation: BridgeTransaction,
    transactionHash: Hex,
  ) {
    const payload = this.payload(operation);
    const result = this.result(operation);
    this.requireAttestation(result);
    const receipt = await this.receipt(
      payload.destinationCode,
      transactionHash,
      payload.destinationChainId,
    );
    if (receipt.status !== 'success') {
      this.invalid(
        'BRIDGE_DESTINATION_TRANSACTION_FAILED',
        'The destination receiveMessage transaction reverted.',
      );
    }
    this.assertSuccessfulReceipt(
      receipt,
      payload.walletAddress,
      payload.destinationMessageTransmitterV2,
    );
    const received = this.decodeMatchingLog(
      receipt.logs,
      CCTP_V2_MESSAGE_RECEIVED_EVENT,
      'MessageReceived',
      payload.destinationMessageTransmitterV2,
    );
    const attestedMessage = result.attestedMessage!;
    const expectedMessageBody: Hex = `0x${attestedMessage.slice(2 + 148 * 2)}`;
    if (
      !matchesCctpV2MessageReceived(received.args, {
        caller: payload.walletAddress,
        sourceDomain: payload.sourceDomain,
        nonce: result.nonce!,
        sender: addressToBytes32(payload.sourceTokenMessengerV2),
        finalityThresholdExecuted: payload.minFinalityThreshold,
        messageBody: expectedMessageBody,
      })
    ) {
      this.invalid(
        'BRIDGE_DESTINATION_MISMATCH',
        'The destination CCTP receipt does not match this bridge intent.',
      );
    }
    const destinationRegistry = BRIDGE_TESTNET_BY_CODE[payload.destinationCode];
    const mintEvidenceEmitter = getAddress(
      payload.destinationMintEvidenceEmitter ??
        destinationRegistry.mintEvidenceEmitter,
    );
    const mintEvidenceDecimals =
      payload.destinationMintEvidenceDecimals ??
      destinationRegistry.mintEvidenceDecimals;
    const expectedMintEvidence =
      BigInt(result.mintAmount ?? '-1') *
      10n ** BigInt(mintEvidenceDecimals - 6);
    const mint = this.decodeMatchingLog(
      receipt.logs,
      USDC_TRANSFER_EVENT,
      'Transfer',
      mintEvidenceEmitter,
    );
    if (
      !isAddressEqual(
        mint.args.from as Address,
        '0x0000000000000000000000000000000000000000',
      ) ||
      !isAddressEqual(mint.args.to as Address, payload.recipientAddress) ||
      mint.args.value !== expectedMintEvidence
    ) {
      this.invalid(
        'BRIDGE_MINT_MISMATCH',
        'The destination USDC mint does not match the verified attestation.',
      );
    }
    const client = this.getClient(payload.destinationCode);
    const transaction = await client.getTransaction({ hash: transactionHash });
    if (
      !transaction.to ||
      !isAddressEqual(
        transaction.to,
        payload.destinationMessageTransmitterV2,
      ) ||
      !isAddressEqual(transaction.from, payload.walletAddress)
    ) {
      this.invalid(
        'BRIDGE_DESTINATION_CALL_MISMATCH',
        'Destination transaction target or signer does not match the intent.',
      );
    }
    let call: ReturnType<typeof decodeFunctionData>;
    try {
      call = decodeFunctionData({
        abi: RECEIVE_MESSAGE_ABI,
        data: transaction.input,
      });
    } catch {
      this.invalid(
        'BRIDGE_DESTINATION_CALL_MISMATCH',
        'Destination transaction is not a valid CCTP V2 receiveMessage call.',
      );
    }
    const [submittedMessage, submittedAttestation] = call.args as readonly [
      Hex,
      Hex,
    ];
    if (
      call.functionName !== 'receiveMessage' ||
      submittedMessage.toLowerCase() !== attestedMessage.toLowerCase() ||
      submittedAttestation.toLowerCase() !== result.attestation!.toLowerCase()
    ) {
      this.invalid(
        'BRIDGE_DESTINATION_CALL_MISMATCH',
        'Destination receiveMessage calldata does not exactly match the persisted Circle message and attestation.',
      );
    }
    if (!(await this.isNonceUsed(payload, result.nonce!))) {
      this.invalid(
        'BRIDGE_NONCE_NOT_USED',
        'The official destination MessageTransmitterV2 has not marked this nonce as used.',
      );
    }

    return this.update(operation, 'completed', {
      ...result,
      destinationTransactionHash: transactionHash,
      completedAt: new Date().toISOString(),
    });
  }

  private requireAttestation(result: BridgeLifecycleResult) {
    if (
      !result.attestedMessage ||
      !isHex(result.attestedMessage) ||
      !result.attestation ||
      !isHex(result.attestation) ||
      !result.nonce
    ) {
      this.invalid(
        'BRIDGE_ATTESTATION_REQUIRED',
        'The exact complete Circle CCTP message and attestation are required.',
      );
    }
  }

  private async isNonceUsed(payload: BridgeIntentPayload, nonce: Hex) {
    const client = this.getClient(payload.destinationCode);
    if ((await client.getChainId()) !== payload.destinationChainId) {
      this.invalid(
        'BRIDGE_CHAIN_MISMATCH',
        'The RPC is not the configured destination chain.',
      );
    }
    return (
      (await client.readContract({
        address: payload.destinationMessageTransmitterV2,
        abi: USED_NONCES_ABI,
        functionName: 'usedNonces',
        args: [nonce],
      })) === 1n
    );
  }

  private getRoute(sourceCode: string, destinationCode: string) {
    try {
      return assertBridgeRoute(sourceCode, destinationCode);
    } catch (error) {
      this.invalid(
        'BRIDGE_ROUTE_UNSUPPORTED',
        error instanceof Error ? error.message : 'Unsupported bridge route.',
      );
    }
  }

  private async recoverSourceMessage(
    payload: BridgeIntentPayload,
    result: BridgeLifecycleResult,
  ) {
    const receipt = await this.receipt(
      payload.sourceCode,
      result.sourceTransactionHash as Hex,
      payload.sourceChainId,
    );
    this.assertSuccessfulReceipt(
      receipt,
      payload.walletAddress,
      payload.sourceTokenMessengerV2,
    );
    const sourceMessageTransmitter = getAddress(
      payload.sourceMessageTransmitterV2 ??
        BRIDGE_TESTNET_BY_CODE[payload.sourceCode].messageTransmitterV2,
    );
    const sent = this.decodeMatchingLog(
      receipt.logs,
      CCTP_V2_MESSAGE_SENT_EVENT,
      'MessageSent',
      sourceMessageTransmitter,
    );
    const message = sent.args.message as Hex;
    if (!isHex(message) || message === '0x') {
      this.invalid(
        'BRIDGE_MESSAGE_INVALID',
        'The source MessageSent event contains no canonical CCTP message.',
      );
    }
    const messageHash = keccak256(message);
    const decoded = decodeCctpV2Message(message);
    if (!matchesBridgeSourceMessage(payload, decoded)) {
      this.invalid(
        'BRIDGE_SOURCE_MESSAGE_MISMATCH',
        'The source MessageSent event does not match the persisted bridge intent.',
      );
    }
    if (result.sourceMessageHash && result.sourceMessageHash !== messageHash) {
      this.invalid(
        'BRIDGE_MESSAGE_HASH_MISMATCH',
        'The persisted source message hash does not match the source receipt.',
      );
    }
    if (decoded.messageHash !== messageHash) {
      this.invalid(
        'BRIDGE_MESSAGE_HASH_MISMATCH',
        'The recovered CCTP message hash is invalid.',
      );
    }
    return { message, messageHash, sourceDecoded: decoded };
  }

  private async getOwned(id: string, walletAddress: string) {
    const operation = await this.prisma.bridgeTransaction.findUnique({
      where: { id },
    });
    if (!operation) throw new NotFoundException('Bridge intent not found.');
    const payload = this.payload(operation);
    if (!isAddressEqual(getAddress(walletAddress), payload.walletAddress)) {
      throw new NotFoundException('Bridge intent not found.');
    }
    return operation;
  }

  private assertSameIntent(
    operation: BridgeTransaction,
    candidate: BridgeIntentPayload,
  ) {
    const existing = this.payload(operation);
    const fields: Array<keyof BridgeIntentPayload> = [
      'sourceCode',
      'destinationCode',
      'walletAddress',
      'recipientAddress',
      'amount',
      'maxFee',
      'minFinalityThreshold',
    ];
    if (
      fields.some(
        (field) =>
          String(existing[field]).toLowerCase() !==
          String(candidate[field]).toLowerCase(),
      )
    ) {
      throw new ConflictException(
        'The idempotency key is already bound to a different bridge intent.',
      );
    }
  }

  private payload(operation: BridgeTransaction): BridgeIntentPayload {
    return operation.payload as unknown as BridgeIntentPayload;
  }

  private result(operation: BridgeTransaction): BridgeLifecycleResult {
    return (operation.result ?? {}) as unknown as BridgeLifecycleResult;
  }

  private async assertResultValueUnused(
    operationId: string,
    field: keyof BridgeLifecycleResult,
    value: string,
    message: string,
  ) {
    const duplicate = await this.prisma.bridgeTransaction.findFirst({
      where: {
        id: { not: operationId },
        result: { path: [field], equals: value },
      },
      select: { id: true },
    });
    if (duplicate) throw new ConflictException(message);
  }

  private toResponse(operation: BridgeTransaction) {
    return {
      operationId: operation.id,
      taskId: operation.taskId,
      status: operation.status as BridgeLifecycleStatus,
      intent: this.payload(operation),
      result: this.result(operation),
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    };
  }

  private async update(
    operation: BridgeTransaction,
    status: BridgeLifecycleStatus,
    result: BridgeLifecycleResult,
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const bridge = await tx.bridgeTransaction.update({
        where: { id: operation.id },
        data: {
          status,
          result: result as unknown as Prisma.InputJsonValue,
          messageHash: result.messageHash?.toLowerCase(),
          nonce: result.nonce?.toLowerCase(),
          destinationTransactionHash:
            result.destinationTransactionHash?.toLowerCase(),
          destinationLeaseId: status === 'completed' ? null : undefined,
          destinationLeaseExpiresAt: status === 'completed' ? null : undefined,
        },
      });
      await tx.task.update({
        where: { id: operation.taskId },
        data: {
          status: status === 'completed' ? 'executed' : 'in_progress',
          result: result as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.taskLog.create({
        data: {
          taskId: operation.taskId,
          step: `bridge.${status}`,
          status: status === 'completed' ? 'executed' : 'in_progress',
          message: `External-wallet CCTP bridge advanced to ${status}.`,
        },
      });
      return bridge;
    });
    return this.toResponse(updated);
  }

  private getClient(code: BridgeTestnetCode): PublicClient {
    const existing = this.clients.get(code);
    if (existing) return existing;
    const network = BRIDGE_TESTNET_BY_CODE[code];
    const configured = process.env[network.rpcEnvKey]?.trim();
    const client = createPublicClient({
      transport: http(configured || network.defaultRpcUrl),
    });
    this.clients.set(code, client);
    return client;
  }

  private irisBaseUrl() {
    const configured = process.env.CCTP_IRIS_BASE_URL?.trim();
    if (configured && configured !== CCTP_V2_TESTNET_IRIS_BASE_URL) {
      this.invalid(
        'BRIDGE_CONFIGURATION_ERROR',
        'CCTP Iris configuration does not match the testnet registry.',
      );
    }
    return String(CCTP_V2_TESTNET_IRIS_BASE_URL);
  }

  private async receipt(
    code: BridgeTestnetCode,
    hash: Hex,
    expectedChainId: number,
  ) {
    const client = this.getClient(code);
    if (
      !matchesExpectedDestinationChain(
        await client.getChainId(),
        expectedChainId,
      )
    ) {
      this.invalid(
        'BRIDGE_CHAIN_MISMATCH',
        'The RPC is not the configured expected chain.',
      );
    }
    try {
      return await client.getTransactionReceipt({ hash });
    } catch {
      throw new BadGatewayException(
        'The transaction receipt is not available on the expected testnet.',
      );
    }
  }

  private assertSuccessfulReceipt(
    receipt: TransactionReceipt,
    from: Address,
    to: Address,
  ) {
    if (
      receipt.status !== 'success' ||
      !receipt.from ||
      !receipt.to ||
      !isAddressEqual(receipt.from, from) ||
      !isAddressEqual(receipt.to, to)
    ) {
      this.invalid(
        'BRIDGE_RECEIPT_MISMATCH',
        'The confirmed transaction signer, target, or status does not match this bridge intent.',
      );
    }
  }

  private decodeMatchingLog(
    logs: readonly Log[],
    abi: Parameters<typeof decodeEventLog>[0]['abi'],
    eventName: string,
    emitter?: Address,
  ) {
    for (const log of logs) {
      if (emitter && !isAddressEqual(log.address, emitter)) continue;
      try {
        const decoded = decodeEventLog({
          abi,
          eventName,
          data: log.data,
          topics: log.topics,
        });
        return decoded as { args: Record<string, unknown> };
      } catch {
        // Keep scanning for the exact event and emitter.
      }
    }
    this.invalid(
      'BRIDGE_EVENT_MISSING',
      `The confirmed receipt is missing the expected ${eventName} event.`,
    );
  }

  private assertAttestedMessage(
    payload: BridgeIntentPayload,
    decoded: ReturnType<typeof decodeCctpV2Message>,
  ) {
    if (!matchesBridgeAttestation(payload, decoded)) {
      this.invalid(
        'BRIDGE_ATTESTATION_MISMATCH',
        'Circle attestation data does not match the original bridge intent.',
      );
    }
  }

  private positiveUint(value: string, field: string) {
    const parsed = this.uint(value, field);
    if (parsed <= 0n)
      this.invalid(
        'BRIDGE_AMOUNT_INVALID',
        `${field} must be greater than zero.`,
      );
    return parsed;
  }

  private uint(value: string, field: string) {
    if (!/^(0|[1-9][0-9]*)$/.test(value))
      this.invalid(
        'BRIDGE_AMOUNT_INVALID',
        `${field} must be an unsigned base-unit integer.`,
      );
    return BigInt(value);
  }

  private invalid(code: string, message: string): never {
    throw new BadRequestException({ code, message });
  }
}
