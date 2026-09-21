import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  getAddress,
  isAddress,
  isAddressEqual,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import {
  assertBridgeRoute,
  BridgeRegistryError,
  CCTP_PRODUCTION,
  getBridgeChain,
  getBridgeFinalityThreshold,
  getBridgeTransferMode,
} from '@wizpay/bridge-registry';
import { getArcCctpResource } from '@wizpay/arc-network';
import { PrismaService } from '../database/prisma.service';
import type {
  AuthorizeBridgeDestinationDto,
  BridgeWalletDto,
  CreateBridgeIntentDto,
  ReportBridgeApprovalDto,
  ReportBridgeDestinationDto,
  ReportBridgeSourceDto,
  SubmitBridgeDestinationDto,
} from './dto/bridge-intent.dto';
import { decodeCctpV2Message } from './bridge-message';

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
  minFinalityThreshold: 1000 | 2000;
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
  /**
   * Latest Circle Iris status for the source burn (e.g. complete,
   * pending_confirmations) and the machine-readable delayReason when Iris
   * provides one (e.g. insufficient_fee). Persisted so the UI can
   * distinguish "not indexed" from "awaiting finality" from
   * "fee/allowance blocked" instead of showing one generic message.
   */
  attestationStatus?: string;
  attestationDelayReason?: string | null;
}

export interface BridgeIntentView {
  id: string;
  status: BridgeLifecycleStatus;
  payload: BridgeIntentPayload;
  result: BridgeLifecycleResult | null;
  createdAt: string;
  updatedAt: string;
}

type StoredBridgeRow = {
  id: string;
  taskId: string;
  status: string;
  payload: unknown;
  result: unknown;
  messageHash: string | null;
  nonce: string | null;
  destinationTransactionHash: string | null;
  destinationLeaseId: string | null;
  destinationLeaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;
const DESTINATION_LEASE_TTL_MS = 5 * 60_000;

/**
 * BridgeLifecycleService — official Circle CCTP lifecycle on Arc Mainnet.
 *
 * Self-custodial model: the connected user wallet signs the source-chain USDC
 * approval and the TokenMessengerV2 `depositForBurn` burn, polls the Circle
 * attestation service (via this backend), then signs the destination
 * MessageTransmitterV2 `receiveMessage` mint. The backend never holds keys and
 * never submits user transactions: it persists lifecycle state, fetches Circle
 * attestations, matches decoded CCTP V2 messages against the stored intent,
 * and verifies evidence. Every route is validated against the
 * @wizpay/bridge-registry production registry (Arc-centric, mainnet-only).
 */
@Injectable()
export class BridgeLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async createIntent(input: CreateBridgeIntentDto): Promise<BridgeIntentView> {
    const { source, destination } = this.route(
      input.sourceCode,
      input.destinationCode,
    );
    const walletAddress = this.address(input.walletAddress, 'walletAddress');
    const recipientAddress = this.address(
      input.recipientAddress,
      'recipientAddress',
    );
    const amount = this.amount(input.amount, 'amount');
    const maxFee = this.amount(input.maxFee, 'maxFee');
    if (amount <= 0n) this.invalid('Bridge amount must be greater than zero.');
    if (maxFee > amount)
      this.invalid('Bridge maxFee must not exceed the burn amount.');
    // Authoritative transfer mode per Circle's supported-chains table. There
    // is no user selector: Fast sources (Base/Ethereum/...) must use 1000,
    // N/A sources (Arc/Avalanche/Polygon) must use 2000. A mismatched
    // threshold fails closed before any burn so a Fast route can never
    // silently downgrade to Standard.
    const expectedThreshold = getBridgeFinalityThreshold(source.code);
    if (input.minFinalityThreshold !== expectedThreshold) {
      throw new BadRequestException({
        code: 'BRIDGE_TRANSFER_MODE_MISMATCH',
        message: `Bridge minFinalityThreshold must be ${expectedThreshold} for ${source.code}.`,
      });
    }
    // For Fast routes, re-validate the live Circle fee and allowance
    // server-side so a spoofed low maxFee (which would revert on-chain) or an
    // exhausted allowance fails closed before burning. Standard routes are
    // free and need no live check.
    if (getBridgeTransferMode(source.code) === 'fast') {
      await this.assertFastReady(
        source.domain,
        destination.domain,
        amount,
        maxFee,
      );
    }

    const existing = await this.prisma.bridgeTransaction.findFirst({
      where: {
        payload: { path: ['idempotencyKey'], equals: input.idempotencyKey },
      },
    });
    if (existing) {
      const view = this.view(existing);
      if (
        !isAddressEqual(view.payload.walletAddress, walletAddress) ||
        view.payload.sourceCode !== source.code ||
        view.payload.destinationCode !== destination.code ||
        view.payload.amount !== amount.toString() ||
        view.payload.recipientAddress.toLowerCase() !==
          recipientAddress.toLowerCase()
      ) {
        throw new ConflictException({
          code: 'BRIDGE_INTENT_CONFLICT',
          message:
            'A bridge intent with this idempotency key already exists with different parameters.',
        });
      }
      return view;
    }

    // Permissionless destination caller (bytes32(0)): any address may submit
    // the Circle-attested mint on the destination chain.
    const payload: BridgeIntentPayload = {
      idempotencyKey: input.idempotencyKey,
      sourceCode: source.code,
      destinationCode: destination.code,
      sourceChainId: source.chainId,
      destinationChainId: destination.chainId,
      sourceDomain: source.domain,
      destinationDomain: destination.domain,
      sourceUsdcAddress: getAddress(source.usdcAddress),
      destinationUsdcAddress: getAddress(destination.usdcAddress),
      sourceTokenMessengerV2: getAddress(source.tokenMessengerV2),
      destinationTokenMessengerV2: getAddress(destination.tokenMessengerV2),
      destinationMessageTransmitterV2: getAddress(
        destination.messageTransmitterV2,
      ),
      walletAddress,
      recipientAddress,
      destinationCaller: zeroAddress,
      amount: amount.toString(),
      maxFee: maxFee.toString(),
      minFinalityThreshold: expectedThreshold,
      createdAt: new Date().toISOString(),
    };

    const created = await this.prisma.$transaction(async (tx) => {
      const task = await tx.task.create({
        data: {
          type: 'bridge',
          status: 'bridge_intent',
          payload: {
            idempotencyKey: payload.idempotencyKey,
            sourceCode: payload.sourceCode,
            destinationCode: payload.destinationCode,
          },
        },
      });
      return tx.bridgeTransaction.create({
        data: {
          taskId: task.id,
          status: 'idle',
          payload: { ...payload },
        },
      });
    });
    return this.view(created);
  }

  async getIntent(
    id: string,
    input: BridgeWalletDto,
  ): Promise<BridgeIntentView> {
    const row = await this.required(id);
    this.ownership(row, input.walletAddress);
    return this.view(row);
  }

  async reportApproval(
    id: string,
    input: ReportBridgeApprovalDto,
  ): Promise<BridgeIntentView> {
    const row = await this.required(id);
    this.ownership(row, input.walletAddress);
    const hash = this.txHash(input.transactionHash);
    const result = this.resultOf(row);
    // Idempotent retry with the same hash is allowed; a different hash for
    // the same intent would mask a duplicate on-chain approval, so fail
    // closed instead of overwriting.
    if (
      result.approvalTransactionHash &&
      result.approvalTransactionHash.toLowerCase() !== hash.toLowerCase()
    ) {
      throw new ConflictException({
        code: 'BRIDGE_HASH_CONFLICT',
        message:
          'A different approval transaction is already recorded for this bridge intent.',
      });
    }
    if (
      result.approvalTransactionHash &&
      result.approvalTransactionHash.toLowerCase() === hash.toLowerCase()
    ) {
      return this.view(row);
    }
    const updated = await this.prisma.bridgeTransaction.update({
      where: { id },
      data: {
        status: 'approval_confirmed',
        result: { ...result, approvalTransactionHash: hash },
      },
    });
    return this.view(updated);
  }

  async reportSource(
    id: string,
    input: ReportBridgeSourceDto,
  ): Promise<BridgeIntentView> {
    const row = await this.required(id);
    this.ownership(row, input.walletAddress);
    const hash = this.txHash(input.transactionHash);
    const result = this.resultOf(row);
    // Same duplicate protection as approval: retry with the same source burn
    // hash is idempotent, but a different hash would hide a duplicate burn.
    if (
      result.sourceTransactionHash &&
      result.sourceTransactionHash.toLowerCase() !== hash.toLowerCase()
    ) {
      throw new ConflictException({
        code: 'BRIDGE_HASH_CONFLICT',
        message:
          'A different source transaction is already recorded for this bridge intent.',
      });
    }
    if (
      result.sourceTransactionHash &&
      result.sourceTransactionHash.toLowerCase() === hash.toLowerCase()
    ) {
      return this.view(row);
    }
    const updated = await this.prisma.bridgeTransaction.update({
      where: { id },
      data: {
        status: 'source_confirmed',
        result: { ...result, sourceTransactionHash: hash },
      },
    });
    return this.view(updated);
  }

  async getAttestation(
    id: string,
    input: BridgeWalletDto,
  ): Promise<BridgeIntentView> {
    return this.refreshAttestation(id, input.walletAddress);
  }

  async reattest(
    id: string,
    input: BridgeWalletDto,
  ): Promise<BridgeIntentView> {
    return this.refreshAttestation(id, input.walletAddress);
  }

  async reportDestination(
    id: string,
    input: ReportBridgeDestinationDto,
  ): Promise<BridgeIntentView> {
    const row = await this.required(id);
    this.ownership(row, input.walletAddress);
    const hash = this.txHash(input.transactionHash);
    const messageHash = this.txHash(input.messageHash);
    const view = this.view(row);
    if (
      view.result?.attestedMessage &&
      view.result.messageHash &&
      view.result.messageHash.toLowerCase() !== messageHash.toLowerCase()
    ) {
      throw new ConflictException({
        code: 'BRIDGE_MESSAGE_CONFLICT',
        message:
          'The reported destination message does not match the Circle attestation.',
      });
    }
    const result = this.resultOf(row);
    if (
      result.destinationTransactionHash &&
      result.destinationTransactionHash.toLowerCase() !== hash.toLowerCase()
    ) {
      throw new ConflictException({
        code: 'BRIDGE_HASH_CONFLICT',
        message:
          'A different destination transaction is already recorded for this bridge intent.',
      });
    }
    if (
      result.destinationTransactionHash &&
      result.destinationTransactionHash.toLowerCase() === hash.toLowerCase()
    ) {
      return this.view(row);
    }
    const updated = await this.prisma.bridgeTransaction.update({
      where: { id },
      data: {
        status: 'verifying_destination',
        messageHash,
        destinationTransactionHash: hash,
        result: {
          ...result,
          destinationTransactionHash: hash,
          messageHash,
        },
      },
    });
    return this.view(updated);
  }

  async authorizeDestination(
    id: string,
    input: AuthorizeBridgeDestinationDto,
  ): Promise<BridgeIntentView & { destinationLeaseId: string }> {
    const row = await this.required(id);
    this.ownership(row, input.walletAddress);
    const view = this.view(row);
    if (view.status !== 'attestation_ready') {
      throw new ConflictException({
        code: 'BRIDGE_ATTESTATION_REQUIRED',
        message:
          'A complete Circle attestation is required before authorizing the destination mint.',
      });
    }
    const destinationLeaseId = randomUUID();
    const updated = await this.prisma.bridgeTransaction.update({
      where: { id },
      data: {
        status: 'awaiting_destination_signature',
        destinationLeaseId,
        destinationLeaseExpiresAt: new Date(
          Date.now() + DESTINATION_LEASE_TTL_MS,
        ),
      },
    });
    return {
      ...this.view(updated),
      destinationLeaseId,
    };
  }

  async submitDestination(
    id: string,
    input: SubmitBridgeDestinationDto,
  ): Promise<BridgeIntentView> {
    const row = await this.required(id);
    this.ownership(row, input.walletAddress);
    if (!row.destinationLeaseId || row.destinationLeaseId !== input.leaseId) {
      throw new ConflictException({
        code: 'BRIDGE_LEASE_CONFLICT',
        message:
          'The destination submission lease is missing or owned by another submitter.',
      });
    }
    if (
      !row.destinationLeaseExpiresAt ||
      row.destinationLeaseExpiresAt <= new Date()
    ) {
      throw new ConflictException({
        code: 'BRIDGE_LEASE_EXPIRED',
        message:
          'The destination submission lease expired. Authorize the destination mint again.',
      });
    }
    const hash = this.txHash(input.transactionHash);
    const messageHash = this.txHash(input.messageHash);
    const result = this.resultOf(row);
    const updated = await this.prisma.bridgeTransaction.update({
      where: { id },
      data: {
        status: 'verifying_destination',
        messageHash,
        destinationTransactionHash: hash,
        destinationLeaseId: null,
        destinationLeaseExpiresAt: null,
        result: {
          ...result,
          destinationTransactionHash: hash,
          messageHash,
          destinationSubmittedAt: new Date().toISOString(),
        },
      },
    });
    return this.view(updated);
  }

  async verifyDestination(
    id: string,
    input: BridgeWalletDto,
  ): Promise<BridgeIntentView> {
    const row = await this.required(id);
    this.ownership(row, input.walletAddress);
    const view = this.view(row);
    if (!view.result?.attestation || !view.result?.attestedMessage) {
      throw new ConflictException({
        code: 'BRIDGE_ATTESTATION_REQUIRED',
        message:
          'A complete Circle attestation is required before completing the bridge.',
      });
    }
    if (!view.result.destinationTransactionHash) {
      throw new ConflictException({
        code: 'BRIDGE_DESTINATION_REQUIRED',
        message:
          'The destination mint transaction hash is required before completing the bridge.',
      });
    }
    const result: BridgeLifecycleResult = {
      ...view.result,
      completedAt: new Date().toISOString(),
    };
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.task.updateMany({
        where: { id: row.taskId },
        data: { status: 'completed' },
      });
      return tx.bridgeTransaction.update({
        where: { id },
        data: { status: 'completed', result: { ...result } },
      });
    });
    return this.view(updated);
  }

  private async refreshAttestation(
    id: string,
    walletAddress: string,
  ): Promise<BridgeIntentView> {
    const row = await this.required(id);
    this.ownership(row, walletAddress);
    const view = this.view(row);
    const sourceHash = view.result?.sourceTransactionHash;
    if (!sourceHash) {
      throw new ConflictException({
        code: 'BRIDGE_SOURCE_REQUIRED',
        message:
          'The source burn transaction hash is required before fetching the Circle attestation.',
      });
    }
    const fetched = await this.fetchAttestation(
      view.payload.sourceDomain,
      sourceHash,
    );
    if (!fetched || 'pending' in fetched) {
      const pending = fetched && 'pending' in fetched ? fetched.pending : null;
      const result: BridgeLifecycleResult = {
        ...this.resultOf(row),
        attestationStatus: pending?.status ?? 'not_indexed',
        attestationDelayReason: pending?.delayReason ?? null,
      };
      const updated = await this.prisma.bridgeTransaction.update({
        where: { id },
        data: {
          status: 'waiting_for_attestation',
          result: { ...result },
        },
      });
      return this.view(updated);
    }
    const message = fetched;
    const decoded = decodeCctpV2Message(message.message as Hex);
    if (!matchesBridgeAttestation(view.payload, decoded)) {
      throw new ConflictException({
        code: 'BRIDGE_ATTESTATION_MISMATCH',
        message:
          'The Circle attestation does not match the stored bridge intent.',
      });
    }
    const result: BridgeLifecycleResult = {
      ...this.resultOf(row),
      attestedMessage: message.message as Hex,
      attestation: message.attestation as Hex,
      messageHash: decoded.messageHash,
      nonce: decoded.nonce,
      feeExecuted: decoded.feeExecuted.toString(),
      mintAmount: decoded.amount.toString(),
      attestationStatus: 'complete',
      attestationDelayReason: null,
    };
    const updated = await this.prisma.bridgeTransaction.update({
      where: { id },
      data: {
        status: 'attestation_ready',
        messageHash: decoded.messageHash,
        nonce: decoded.nonce,
        result: { ...result },
      },
    });
    return this.view(updated);
  }

  private async assertFastReady(
    sourceDomain: number,
    destinationDomain: number,
    amount: bigint,
    maxFee: bigint,
  ): Promise<void> {
    const base = (
      this.config.get<string>('CCTP_IRIS_API_BASE_URL') ??
      CCTP_PRODUCTION.irisApiBaseUrl
    ).replace(/\/$/, '');
    const failClosed = (): never => {
      throw new ServiceUnavailableException({
        code: 'BRIDGE_FAST_UNAVAILABLE',
        message: 'Fast CCTP transfer is temporarily unavailable for this route.',
      });
    };
    let feeBps: number;
    try {
      const response = await fetch(
        `${base}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (!response.ok) failClosed();
      const body = (await response.json()) as unknown;
      const list = Array.isArray(body)
        ? body
        : Array.isArray((body as Record<string, unknown>)?.['fees'])
          ? ((body as Record<string, unknown>)['fees'] as unknown[])
          : null;
      const entry = list
        ?.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
        .find(
          (item) =>
            Number(item['finalityThreshold'] ?? item['finality_threshold']) ===
            CCTP_PRODUCTION.fastFinalityThreshold,
        );
      const raw =
        entry?.['minimumFee'] ?? entry?.['minimum_fee'] ?? entry?.['fee'];
      feeBps = typeof raw === 'string' ? Number(raw) : Number(raw);
      if (!Number.isFinite(feeBps) || feeBps < 0 || feeBps > 100) failClosed();
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      failClosed();
    }
    const hundredths = Math.round(feeBps! * 100);
    const protocolFee =
      hundredths === 0
        ? 0n
        : (amount * BigInt(hundredths) + 999_999n) / 1_000_000n;
    if (maxFee < protocolFee) failClosed();
    try {
      const response = await fetch(`${base}/v2/fastBurn/USDC/allowance`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) failClosed();
      const body = (await response.json()) as { allowance?: unknown };
      const text = String(body.allowance ?? '');
      if (!/^\d+(?:\.\d{1,6})?$/.test(text.trim())) failClosed();
      const [whole, frac = ''] = text.trim().split('.');
      const allowanceSubunits =
        BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
      if (allowanceSubunits < amount) failClosed();
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      failClosed();
    }
  }

  private async fetchAttestation(
    sourceDomain: number,
    transactionHash: string,
  ): Promise<
    | { message: string; attestation: string }
    | { pending: { status: string; delayReason: string | null } }
    | null
  > {
    const base =
      this.config.get<string>('CCTP_IRIS_API_BASE_URL') ??
      CCTP_PRODUCTION.irisApiBaseUrl;
    let response: Response;
    try {
      response = await fetch(
        `${base.replace(/\/$/, '')}/v2/messages/${sourceDomain}?transactionHash=${transactionHash}`,
        { signal: AbortSignal.timeout(15_000) },
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'BRIDGE_ATTESTATION_UNAVAILABLE',
        message:
          'The Circle attestation service is temporarily unavailable. Retry shortly.',
        retryable: true,
      });
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new ServiceUnavailableException({
        code: 'BRIDGE_ATTESTATION_UNAVAILABLE',
        message:
          'The Circle attestation service is temporarily unavailable. Retry shortly.',
        retryable: true,
      });
    }
    const body = (await response.json()) as {
      messages?: Array<{
        message?: string;
        attestation?: string;
        status?: string;
        delayReason?: string | null;
      }>;
    };
    const first = body.messages?.[0];
    if (!first) return null;
    if (
      first.status === 'complete' &&
      typeof first.message === 'string' &&
      typeof first.attestation === 'string' &&
      first.message.startsWith('0x') &&
      first.attestation.startsWith('0x')
    ) {
      return { message: first.message, attestation: first.attestation };
    }
    return {
      pending: {
        status: typeof first.status === 'string' ? first.status : 'unknown',
        delayReason:
          typeof first.delayReason === 'string' ? first.delayReason : null,
      },
    };
  }

  private route(sourceCode: string, destinationCode: string) {
    try {
      return assertBridgeRoute(sourceCode, destinationCode);
    } catch (error) {
      if (error instanceof BridgeRegistryError) {
        throw new BadRequestException({
          code: error.code,
          message: error.message,
        });
      }
      throw error;
    }
  }

  private address(value: unknown, label: string): Address {
    if (typeof value !== 'string' || !isAddress(value.trim())) {
      throw new BadRequestException({
        code: 'BRIDGE_INVALID_ADDRESS',
        message: `Bridge ${label} must be a valid EVM address.`,
      });
    }
    return getAddress(value.trim());
  }

  private amount(value: unknown, label: string): bigint {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new BadRequestException({
        code: 'BRIDGE_INVALID_AMOUNT',
        message: `Bridge ${label} must be a canonical positive integer string.`,
      });
    }
    const parsed = BigInt(value);
    if (parsed > BigInt(CCTP_PRODUCTION.maxBurnAmountUnits)) {
      throw new BadRequestException({
        code: 'BRIDGE_AMOUNT_ABOVE_MAX',
        message:
          'Bridge amount exceeds the CCTP single-transfer limit. Split the transfer.',
      });
    }
    return parsed;
  }

  private txHash(value: unknown): Hex {
    if (typeof value !== 'string' || !TRANSACTION_HASH.test(value)) {
      throw new BadRequestException({
        code: 'BRIDGE_INVALID_HASH',
        message: 'Bridge transaction hash is malformed.',
      });
    }
    return value.toLowerCase() as Hex;
  }

  private invalid(message: string): never {
    throw new BadRequestException({
      code: 'BRIDGE_INVALID_REQUEST',
      message,
    });
  }

  private async required(id: string): Promise<StoredBridgeRow> {
    const row = await this.prisma.bridgeTransaction.findUnique({
      where: { id },
    });
    if (!row) {
      throw new NotFoundException({
        code: 'BRIDGE_INTENT_NOT_FOUND',
        message: 'Bridge intent not found.',
      });
    }
    return row;
  }

  private ownership(row: StoredBridgeRow, walletAddress: string): void {
    const stored = (row.payload as Record<string, unknown> | null)
      ?.walletAddress;
    if (
      typeof stored !== 'string' ||
      !isAddress(stored) ||
      !isAddress(walletAddress) ||
      !isAddressEqual(getAddress(stored), getAddress(walletAddress))
    ) {
      throw new ForbiddenException({
        code: 'BRIDGE_INTENT_FORBIDDEN',
        message: 'This bridge intent belongs to another wallet.',
      });
    }
  }

  private resultOf(row: StoredBridgeRow): BridgeLifecycleResult {
    if (
      row.result &&
      typeof row.result === 'object' &&
      !Array.isArray(row.result)
    ) {
      return { ...(row.result as BridgeLifecycleResult) };
    }
    return {};
  }

  private view(row: StoredBridgeRow): BridgeIntentView {
    const payload = row.payload as BridgeIntentPayload;
    // Fail closed when Arc Mainnet CCTP resources stop resolving: persisted
    // intents must always reference the official production contracts.
    const messenger = getArcCctpResource('arc-mainnet', 'tokenMessengerV2');
    const transmitter = getArcCctpResource(
      'arc-mainnet',
      'messageTransmitterV2',
    );
    if (
      messenger.status !== 'available' ||
      transmitter.status !== 'available'
    ) {
      throw new ServiceUnavailableException({
        code: 'BRIDGE_CONFIGURATION_UNAVAILABLE',
        message:
          'Arc Mainnet CCTP resources are unavailable. Bridging stays disabled.',
      });
    }
    void getBridgeChain(payload.sourceCode);
    void getBridgeChain(payload.destinationCode);
    return {
      id: row.id,
      status: row.status as BridgeLifecycleStatus,
      payload,
      result: this.resultOf(row),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export function bridgeUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: 'BRIDGE_UNAVAILABLE',
    message:
      'Bridging is unavailable on Arc Mainnet. Settle directly on Arc Mainnet instead.',
  });
}
