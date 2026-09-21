import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { parseAbi, isAddressEqual, type Address, type Hex } from 'viem';
import type {
  BridgeWalletDto,
  CreateBridgeIntentDto,
  ReportBridgeApprovalDto,
  SubmitBridgeDestinationDto,
  ReportBridgeDestinationDto,
  ReportBridgeSourceDto,
} from './dto/bridge-intent.dto';
import type { decodeCctpV2Message } from './bridge-message';

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
  sourceCode: string;
  destinationCode: string;
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

/**
 * BridgeLifecycleService — fail-closed on Arc Mainnet.
 *
 * No bridge route is available on Mainnet, so every lifecycle operation
 * throws BRIDGE_UNAVAILABLE before any side effect (no tasks, no leases,
 * no RPC reads, no attestation fetches). The pure message-matching helpers
 * above remain exported for codec-level unit tests only.
 */
@Injectable()
export class BridgeLifecycleService {
  async createIntent(_input: CreateBridgeIntentDto): Promise<never> {
    throw bridgeUnavailable();
  }

  async getIntent(
    _id: string,
    _input: BridgeWalletDto,
  ): Promise<never> {
    throw bridgeUnavailable();
  }

  async reportApproval(
    _id: string,
    _input: ReportBridgeApprovalDto,
  ): Promise<never> {
    throw bridgeUnavailable();
  }

  async reportSource(
    _id: string,
    _input: ReportBridgeSourceDto,
  ): Promise<never> {
    throw bridgeUnavailable();
  }

  async getAttestation(
    _id: string,
    _input: BridgeWalletDto,
  ): Promise<never> {
    throw bridgeUnavailable();
  }

  async reattest(_id: string, _input: BridgeWalletDto): Promise<never> {
    throw bridgeUnavailable();
  }

  async reportDestination(
    _id: string,
    _input: ReportBridgeDestinationDto,
  ): Promise<never> {
    throw bridgeUnavailable();
  }

  async authorizeDestination(
    _id: string,
    _input: BridgeWalletDto,
  ): Promise<never> {
    throw bridgeUnavailable();
  }

  async submitDestination(
    _id: string,
    _input: SubmitBridgeDestinationDto,
  ): Promise<never> {
    throw bridgeUnavailable();
  }

  async verifyDestination(
    _id: string,
    _input: BridgeWalletDto,
  ): Promise<never> {
    throw bridgeUnavailable();
  }
}

export function bridgeUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'BRIDGE_UNAVAILABLE',
    message:
      'Bridging is unavailable on Arc Mainnet. Settle directly on Arc Mainnet instead.',
  });
}
