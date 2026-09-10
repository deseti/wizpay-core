import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ExecutionIntentOperation,
  ExecutionIntentRoute,
  ExecutionIntentStatus,
  type ExecutionIntent,
  Prisma,
} from '@prisma/client';
import { createHash } from 'node:crypto';
import { getAddress, isAddressEqual, type Address, type Hex } from 'viem';
import { PrismaService } from '../database/prisma.service';
import {
  PaymentRoutingService,
  type PaymentOperation,
} from '../routing/payment-routing.service';

export const EXECUTION_INTENT_ERROR_CODES = Object.freeze({
  IMMUTABLE_CONFLICT: 'EXECUTION_INTENT_IMMUTABLE_CONFLICT',
  INVALID_TRANSITION: 'EXECUTION_INTENT_INVALID_TRANSITION',
  ACTIVE_LEASE: 'EXECUTION_INTENT_ACTIVE_LEASE',
  TERMINAL: 'EXECUTION_INTENT_TERMINAL',
  HASH_CONFLICT: 'EXECUTION_INTENT_TRANSACTION_HASH_CONFLICT',
  RECEIPT_MISMATCH: 'EXECUTION_INTENT_RECEIPT_MISMATCH',
  NOT_FOUND: 'EXECUTION_INTENT_NOT_FOUND',
  BUSINESS_STATE: 'EXECUTION_INTENT_BUSINESS_STATE_CONFLICT',
});

export const EXECUTION_INTENT_TRANSITIONS: Readonly<
  Record<ExecutionIntentStatus, readonly ExecutionIntentStatus[]>
> = Object.freeze({
  CREATED: [
    'AWAITING_WALLET_SIGNATURE',
    'AUTHORIZATION_PENDING',
    'SUBMISSION_PENDING',
    'FAILED_FINAL',
    'EXPIRED',
    'CANCELLED',
  ],
  AWAITING_WALLET_SIGNATURE: [
    'SUBMITTED',
    'FAILED_RETRYABLE',
    'FAILED_FINAL',
    'CANCELLED',
  ],
  AUTHORIZATION_PENDING: [
    'SUBMISSION_PENDING',
    'SUBMITTED',
    'FAILED_RETRYABLE',
    'FAILED_FINAL',
    'EXPIRED',
  ],
  SUBMISSION_PENDING: [
    'SUBMITTED',
    'FAILED_RETRYABLE',
    'FAILED_FINAL',
    'EXPIRED',
  ],
  SUBMITTED: ['VERIFYING', 'FAILED_RETRYABLE', 'FAILED_FINAL'],
  VERIFYING: ['COMPLETED', 'FAILED_RETRYABLE', 'FAILED_FINAL'],
  FAILED_RETRYABLE: [
    'AWAITING_WALLET_SIGNATURE',
    'AUTHORIZATION_PENDING',
    'SUBMISSION_PENDING',
    'SUBMITTED',
    'VERIFYING',
    'FAILED_FINAL',
    'EXPIRED',
  ],
  COMPLETED: [],
  FAILED_FINAL: [],
  EXPIRED: [],
  CANCELLED: [],
});

export type ExecutionIntentAcquireInput = Readonly<{
  network: 'arc-testnet' | 'arc-mainnet';
  operation: ExecutionIntentOperation;
  ownerId?: string | null;
  sourceWallet: string;
  recipient?: string | null;
  batchDigest?: string | null;
  tokenIn: string;
  tokenOut: string;
  amountUnits: string;
  externalReference: string;
  taskId?: string | null;
}>;

type CanonicalAcquireInput = Readonly<{
  network: 'arc-testnet' | 'arc-mainnet';
  operation: ExecutionIntentOperation;
  ownerId: string | null;
  sourceWallet: Address;
  recipient: Address | null;
  batchDigest: string | null;
  tokenIn: Address;
  tokenOut: Address;
  amountUnits: string;
  externalReference: string;
  logicalKey: string;
  requestFingerprint: string;
  idempotencyKey: string;
  route: ExecutionIntentRoute;
  provider: string | null;
  taskId: string | null;
}>;

export type VerifiedExecutionReceipt = Readonly<{
  network: string;
  transactionHash: Hex;
  sourceWallet: string;
  token: string;
  recipient?: string | null;
  batchDigest?: string | null;
  amountUnits: string;
}>;

@Injectable()
export class ExecutionIntentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: PaymentRoutingService,
  ) {}

  async acquire(input: ExecutionIntentAcquireInput): Promise<ExecutionIntent> {
    const canonical = this.canonicalize(input);
    let intent: ExecutionIntent | null = null;
    for (let attempt = 0; attempt < 3 && !intent; attempt += 1) {
      try {
        intent = await this.prisma.$transaction(
          async (tx) => {
            const existing = await tx.executionIntent.findUnique({
              where: { logicalKey: canonical.logicalKey },
            });
            if (existing) return existing;
            if (
              canonical.operation === 'PAYMENT_LINK_SETTLEMENT' ||
              canonical.operation === 'INVOICE_SETTLEMENT'
            ) {
              const invoice = await tx.invoice.findUnique({
                where: { publicId: canonical.externalReference },
                select: {
                  status: true,
                  expiresAt: true,
                  chainId: true,
                  merchantWalletAddress: true,
                  tokenAddress: true,
                  amountUnits: true,
                  settlementKind: true,
                },
              });
              if (
                !invoice ||
                invoice.status !== 'OPEN' ||
                (invoice.expiresAt && invoice.expiresAt <= new Date()) ||
                invoice.chainId !== this.routing.chainId ||
                !canonical.recipient ||
                !isAddressEqual(
                  getAddress(invoice.merchantWalletAddress),
                  canonical.recipient,
                ) ||
                !isAddressEqual(
                  getAddress(invoice.tokenAddress),
                  canonical.tokenOut,
                ) ||
                invoice.amountUnits !== canonical.amountUnits ||
                (canonical.operation === 'INVOICE_SETTLEMENT' &&
                  invoice.settlementKind !== 'INVOICE') ||
                (canonical.operation === 'PAYMENT_LINK_SETTLEMENT' &&
                  invoice.settlementKind !== 'PAYMENT_LINK')
              )
                this.conflict(
                  EXECUTION_INTENT_ERROR_CODES.BUSINESS_STATE,
                  'The invoice cannot create an executable settlement intent.',
                );
            }
            return tx.executionIntent.upsert({
              where: { logicalKey: canonical.logicalKey },
              update: {},
              create: canonical,
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        const retryableConcurrency =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2002' || error.code === 'P2034');
        if (!retryableConcurrency) throw error;
        intent = await this.prisma.executionIntent.findUnique({
          where: { logicalKey: canonical.logicalKey },
        });
        if (!intent && attempt === 2) throw error;
      }
    }
    if (!intent) throw new Error('Execution intent acquisition failed.');
    if (intent.requestFingerprint !== canonical.requestFingerprint) {
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT,
        'The logical operation is already bound to different immutable request data.',
      );
    }
    return intent;
  }

  async get(id: string): Promise<ExecutionIntent> {
    const intent = await this.prisma.executionIntent.findUnique({
      where: { id },
    });
    if (!intent)
      throw new NotFoundException({
        code: EXECUTION_INTENT_ERROR_CODES.NOT_FOUND,
        message: 'Execution intent not found.',
      });
    return intent;
  }

  async getByTransactionHash(hash: string): Promise<ExecutionIntent> {
    const transactionHash = this.transactionHash(hash);
    const intent = await this.prisma.executionIntent.findUnique({
      where: { transactionHash },
    });
    if (!intent)
      throw new NotFoundException({
        code: EXECUTION_INTENT_ERROR_CODES.NOT_FOUND,
        message:
          'A durable execution intent must be created before submission.',
      });
    return intent;
  }

  async beginVerification(id: string): Promise<ExecutionIntent> {
    let intent = await this.get(id);
    if (intent.status === 'COMPLETED' || intent.status === 'VERIFYING')
      return intent;
    if (intent.status === 'CREATED') {
      intent = await this.transition(id, 'CREATED', 'SUBMISSION_PENDING');
    }
    if (intent.status === 'AUTHORIZATION_PENDING') {
      intent = await this.transition(id, 'AUTHORIZATION_PENDING', 'SUBMITTED');
    } else if (intent.status === 'SUBMISSION_PENDING') {
      intent = await this.transition(id, 'SUBMISSION_PENDING', 'SUBMITTED');
    }
    if (intent.status === 'SUBMITTED')
      intent = await this.transition(id, 'SUBMITTED', 'VERIFYING');
    else if (intent.status === 'FAILED_RETRYABLE')
      intent = await this.transition(id, 'FAILED_RETRYABLE', 'VERIFYING');
    return intent;
  }

  async attachTask(id: string, taskId: string): Promise<ExecutionIntent> {
    const existing = await this.get(id);
    if (existing.taskId && existing.taskId !== taskId)
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT,
        'Execution intent is already bound to a different task.',
      );
    await this.prisma.executionIntent.updateMany({
      where: { id, taskId: null },
      data: { taskId },
    });
    return this.get(id);
  }

  async acquireLease(
    id: string,
    leaseOwner: string,
    ttlMs: number,
    now = new Date(),
  ): Promise<ExecutionIntent> {
    if (!leaseOwner.trim() || ttlMs < 1_000 || ttlMs > 15 * 60_000)
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.ACTIVE_LEASE,
        'Execution lease parameters are invalid.',
      );
    const result = await this.prisma.executionIntent.updateMany({
      where: {
        id,
        status: {
          notIn: ['COMPLETED', 'FAILED_FINAL', 'EXPIRED', 'CANCELLED'],
        },
        OR: [
          { leaseOwner: null },
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        leaseOwner,
        leaseExpiresAt: new Date(now.getTime() + ttlMs),
        attemptCount: { increment: 1 },
      },
    });
    if (result.count !== 1) {
      const existing = await this.get(id);
      if (this.isTerminal(existing.status))
        this.conflict(
          EXECUTION_INTENT_ERROR_CODES.TERMINAL,
          'A terminal execution intent cannot be leased.',
        );
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.ACTIVE_LEASE,
        'The execution intent already has an active lease.',
      );
    }
    return this.get(id);
  }

  async prepareWalletSignature(
    id: string,
    idempotencyKey: string,
    leaseOwner: string,
    ttlMs = 5 * 60_000,
  ): Promise<ExecutionIntent> {
    await this.assertAccess(id, idempotencyKey);
    const current = await this.get(id);
    if (this.isTerminal(current.status))
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.TERMINAL,
        'A terminal execution intent cannot be submitted again.',
      );
    if (current.transactionHash || current.circleChallengeId)
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.INVALID_TRANSITION,
        'Existing submission evidence must be reconciled instead of rebroadcast.',
      );
    if (current.status === 'AWAITING_WALLET_SIGNATURE')
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.INVALID_TRANSITION,
        'The wallet outcome is unresolved. Bind a known hash or cancel explicitly; automatic rebroadcast is disabled.',
      );
    if (current.status !== 'CREATED' && current.status !== 'FAILED_RETRYABLE')
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.INVALID_TRANSITION,
        `Execution intent is in ${current.status} and cannot open a wallet submission.`,
      );
    await this.acquireLease(id, leaseOwner, ttlMs);
    return this.transition(id, current.status, 'AWAITING_WALLET_SIGNATURE');
  }

  async assertLease(id: string, leaseOwner: string): Promise<ExecutionIntent> {
    const intent = await this.get(id);
    if (
      !leaseOwner ||
      intent.leaseOwner !== leaseOwner ||
      !intent.leaseExpiresAt ||
      intent.leaseExpiresAt <= new Date()
    )
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.ACTIVE_LEASE,
        'The active execution lease is missing, expired, or owned by another submitter.',
      );
    return intent;
  }

  async bindImmutableExecutionContext(
    id: string,
    input: {
      ownerId: string;
      walletId: string;
      contractAddress?: string | null;
      calldataHash?: string | null;
    },
  ): Promise<ExecutionIntent> {
    const existing = await this.get(id);
    const normalized = {
      ownerId: input.ownerId.trim(),
      walletId: input.walletId.trim(),
      contractAddress: input.contractAddress
        ? getAddress(input.contractAddress).toLowerCase()
        : null,
      calldataHash: input.calldataHash?.toLowerCase() ?? null,
    };
    for (const key of [
      'ownerId',
      'walletId',
      'contractAddress',
      'calldataHash',
    ] as const) {
      const prior = existing[key];
      if (prior && normalized[key] && prior !== normalized[key])
        this.conflict(
          EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT,
          `Execution intent ${key} is already bound to another value.`,
        );
    }
    const result = await this.prisma.executionIntent.updateMany({
      where: {
        id,
        ownerId: existing.ownerId,
        walletId: existing.walletId,
        contractAddress: existing.contractAddress,
        calldataHash: existing.calldataHash,
      },
      data: {
        ownerId: existing.ownerId ?? normalized.ownerId,
        walletId: existing.walletId ?? normalized.walletId,
        contractAddress: existing.contractAddress ?? normalized.contractAddress,
        calldataHash: existing.calldataHash ?? normalized.calldataHash,
      },
    });
    if (result.count !== 1)
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT,
        'Execution intent context was concurrently bound to another value.',
      );
    const bound = await this.get(id);
    if (
      bound.ownerId !== normalized.ownerId ||
      bound.walletId !== normalized.walletId ||
      bound.contractAddress !== normalized.contractAddress ||
      bound.calldataHash !== normalized.calldataHash
    )
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT,
        'Execution intent context does not match the transaction request.',
      );
    return bound;
  }

  async transition(
    id: string,
    expected: ExecutionIntentStatus,
    next: ExecutionIntentStatus,
    data: {
      failureCode?: string | null;
      circleChallengeId?: string | null;
      circleTransactionId?: string | null;
    } = {},
  ): Promise<ExecutionIntent> {
    if (!EXECUTION_INTENT_TRANSITIONS[expected].includes(next))
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.INVALID_TRANSITION,
        `Execution intent transition ${expected} -> ${next} is not allowed.`,
      );
    const result = await this.prisma.executionIntent.updateMany({
      where: { id, status: expected },
      data: {
        status: next,
        ...data,
        ...(next === 'COMPLETED' ? { completedAt: new Date() } : {}),
      },
    });
    if (result.count !== 1) {
      const current = await this.get(id);
      this.conflict(
        this.isTerminal(current.status)
          ? EXECUTION_INTENT_ERROR_CODES.TERMINAL
          : EXECUTION_INTENT_ERROR_CODES.INVALID_TRANSITION,
        `Execution intent is in ${current.status}, not ${expected}.`,
      );
    }
    return this.get(id);
  }

  async bindCircleCorrelation(
    id: string,
    input: { challengeId: string; transactionId?: string | null },
  ): Promise<ExecutionIntent> {
    const existing = await this.get(id);
    if (
      (existing.circleChallengeId &&
        existing.circleChallengeId !== input.challengeId) ||
      (existing.circleTransactionId &&
        input.transactionId &&
        existing.circleTransactionId !== input.transactionId)
    )
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT,
        'Circle correlation is already bound to this execution intent.',
      );
    try {
      const result = await this.prisma.executionIntent.updateMany({
        where: {
          id,
          circleChallengeId: existing.circleChallengeId,
          circleTransactionId: existing.circleTransactionId,
        },
        data: {
          circleChallengeId: existing.circleChallengeId ?? input.challengeId,
          circleTransactionId:
            existing.circleTransactionId ?? input.transactionId ?? null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      if (result.count !== 1) throw new Error('concurrent update');
    } catch {
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT,
        'Circle correlation is already bound to another execution intent.',
      );
    }
    const bound = await this.get(id);
    if (
      bound.circleChallengeId !== input.challengeId ||
      (input.transactionId && bound.circleTransactionId !== input.transactionId)
    )
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT,
        'Circle correlation was concurrently changed.',
      );
    return bound;
  }

  async bindTransactionHash(
    id: string,
    hash: string,
    leaseOwner?: string,
    recovery = false,
  ): Promise<ExecutionIntent> {
    const normalized = this.transactionHash(hash);
    const existing = await this.get(id);
    if (existing.transactionHash === normalized) return existing;
    if (existing.transactionHash)
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.HASH_CONFLICT,
        'A different transaction hash is already bound to this execution intent.',
      );
    if (existing.status === 'AWAITING_WALLET_SIGNATURE' && !recovery) {
      if (!leaseOwner)
        this.conflict(
          EXECUTION_INTENT_ERROR_CODES.ACTIVE_LEASE,
          'The wallet submission lease is required.',
        );
      await this.assertLease(id, leaseOwner);
    }
    try {
      const result = await this.prisma.executionIntent.updateMany({
        where: { id, transactionHash: null },
        data: {
          transactionHash: normalized,
          status: 'SUBMITTED',
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      if (result.count !== 1)
        return this.bindTransactionHash(id, normalized, leaseOwner, recovery);
    } catch {
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.HASH_CONFLICT,
        'The transaction hash is already bound to another execution intent.',
      );
    }
    return this.get(id);
  }

  async bindKnownTransactionHash(
    id: string,
    idempotencyKey: string,
    hash: string,
  ): Promise<ExecutionIntent> {
    await this.assertAccess(id, idempotencyKey);
    const intent = await this.get(id);
    if (this.isTerminal(intent.status) && intent.status !== 'COMPLETED')
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.TERMINAL,
        'A terminal execution intent cannot accept recovery evidence.',
      );
    return this.bindTransactionHash(id, hash, undefined, true);
  }

  async cancelUnsubmitted(
    id: string,
    idempotencyKey: string,
  ): Promise<ExecutionIntent> {
    await this.assertAccess(id, idempotencyKey);
    const intent = await this.get(id);
    if (
      intent.transactionHash ||
      intent.circleChallengeId ||
      intent.circleTransactionId
    )
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.INVALID_TRANSITION,
        'An intent with submission evidence cannot be cancelled.',
      );
    if (
      !['CREATED', 'AWAITING_WALLET_SIGNATURE', 'FAILED_RETRYABLE'].includes(
        intent.status,
      )
    )
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.INVALID_TRANSITION,
        `Execution intent in ${intent.status} cannot be cancelled.`,
      );
    const result = await this.prisma.executionIntent.updateMany({
      where: { id, transactionHash: null, circleChallengeId: null },
      data: {
        status: 'CANCELLED',
        leaseOwner: null,
        leaseExpiresAt: null,
      },
    });
    if (result.count !== 1)
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.INVALID_TRANSITION,
        'Submission evidence appeared while cancellation was processed.',
      );
    return this.get(id);
  }

  async completeWithVerifiedReceipt(
    id: string,
    receipt: VerifiedExecutionReceipt,
  ): Promise<ExecutionIntent> {
    const intent = await this.get(id);
    const hash = this.transactionHash(receipt.transactionHash);
    const matches =
      intent.status === 'VERIFYING' &&
      intent.transactionHash === hash &&
      intent.network === receipt.network &&
      isAddressEqual(
        getAddress(intent.sourceWallet),
        getAddress(receipt.sourceWallet),
      ) &&
      isAddressEqual(getAddress(intent.tokenOut), getAddress(receipt.token)) &&
      intent.amountUnits === receipt.amountUnits &&
      (intent.recipient
        ? Boolean(
            receipt.recipient &&
            isAddressEqual(
              getAddress(intent.recipient),
              getAddress(receipt.recipient),
            ),
          )
        : intent.batchDigest === receipt.batchDigest);
    if (!matches)
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.RECEIPT_MISMATCH,
        'Verified receipt data does not match the immutable execution intent.',
      );
    return this.transition(id, 'VERIFYING', 'COMPLETED');
  }

  circleIdempotencyKey(
    intent: Pick<ExecutionIntent, 'idempotencyKey'>,
  ): string {
    return intent.idempotencyKey;
  }

  async assertAccess(
    id: string,
    idempotencyKey: string,
  ): Promise<ExecutionIntent> {
    const intent = await this.get(id);
    if (intent.idempotencyKey !== idempotencyKey)
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT,
        'Execution intent access key does not match.',
      );
    return intent;
  }

  private canonicalize(
    input: ExecutionIntentAcquireInput,
  ): CanonicalAcquireInput {
    const sourceWallet = getAddress(input.sourceWallet);
    const recipient = input.recipient ? getAddress(input.recipient) : null;
    const amountUnits = this.baseUnits(input.amountUnits);
    const externalReference = input.externalReference.trim();
    if (!externalReference || externalReference.length > 160)
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT,
        'A stable external business reference is required.',
      );
    if (!recipient && !input.batchDigest)
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT,
        'An execution intent requires a recipient or deterministic batch digest.',
      );
    const operation = this.routingOperation(input.operation);
    const decision = this.routing.assertExecutable(
      this.routing.decide({
        network: input.network,
        operation,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
      }),
    );
    const immutable = {
      network: input.network,
      operation: input.operation,
      ownerId: input.ownerId?.trim() || null,
      sourceWallet,
      recipient,
      batchDigest: input.batchDigest?.trim().toLowerCase() || null,
      tokenIn: decision.tokenIn,
      tokenOut: decision.tokenOut,
      amountUnits,
      externalReference,
    };
    const logicalKey = sha256(
      stableJson({
        network: immutable.network,
        operation: immutable.operation,
        ...(immutable.operation === 'PAYMENT_LINK_SETTLEMENT' ||
        immutable.operation === 'INVOICE_SETTLEMENT'
          ? {}
          : {
              ownerId: immutable.ownerId,
              sourceWallet: immutable.sourceWallet.toLowerCase(),
            }),
        externalReference,
      }),
    );
    const requestFingerprint = sha256(stableJson(immutable));
    return {
      ...immutable,
      logicalKey,
      requestFingerprint,
      idempotencyKey: uuidFromHash(sha256(`wizpay:${requestFingerprint}`)),
      route: decision.kind as ExecutionIntentRoute,
      provider: decision.provider,
      taskId: input.taskId ?? null,
    };
  }

  private routingOperation(
    operation: ExecutionIntentOperation,
  ): PaymentOperation {
    if (operation === 'SEND') return 'SEND';
    if (operation === 'PAYROLL' || operation === 'TOKEN_APPROVAL')
      return 'PAYROLL';
    return 'PAYMENT_LINK';
  }

  private baseUnits(value: string): string {
    if (!/^[1-9]\d*$/.test(value))
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.IMMUTABLE_CONFLICT,
        'Execution amount must be exact positive base units.',
      );
    return BigInt(value).toString();
  }

  private transactionHash(value: string): string {
    if (!/^0x[0-9a-fA-F]{64}$/.test(value))
      this.conflict(
        EXECUTION_INTENT_ERROR_CODES.HASH_CONFLICT,
        'Transaction hash is malformed.',
      );
    return value.toLowerCase();
  }

  private isTerminal(status: ExecutionIntentStatus) {
    return ['COMPLETED', 'FAILED_FINAL', 'EXPIRED', 'CANCELLED'].includes(
      status,
    );
  }

  private conflict(code: string, message: string): never {
    throw new ConflictException({ code, message });
  }
}

export function createPayrollBatchDigest(
  recipients: readonly Readonly<{
    recipient: string;
    token: string;
    amountUnits: string;
  }>[],
): string {
  if (recipients.length === 0)
    throw new Error('Payroll batch cannot be empty.');
  return sha256(
    stableJson(
      recipients.map((entry, index) => ({
        index,
        recipient: getAddress(entry.recipient).toLowerCase(),
        token: getAddress(entry.token).toLowerCase(),
        amountUnits: /^[1-9]\d*$/.test(entry.amountUnits)
          ? BigInt(entry.amountUnits).toString()
          : (() => {
              throw new Error('Payroll amount must be positive base units.');
            })(),
      })),
    ),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, child) =>
    child && typeof child === 'object' && !Array.isArray(child)
      ? Object.fromEntries(
          Object.entries(child as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        )
      : child,
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function uuidFromHash(hash: string): string {
  const chars = hash.slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const value = chars.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
