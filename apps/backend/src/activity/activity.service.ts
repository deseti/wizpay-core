import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Prisma, type Activity } from '@prisma/client';
import { getAddress, isAddress, isAddressEqual } from 'viem';
import { PrismaService } from '../database/prisma.service';
import type { InvoiceMerchantPrincipal } from '../invoice/invoice.types';
import { ARC_MAINNET_CHAIN_ID } from '../config/arc-network.config';
import {
  ACTIVITY_STATUSES,
  ACTIVITY_TYPES,
  type ActivityProjection,
  type ActivityStatus,
  type ActivitySyncResult,
  type ActivitySyncSummary,
  type ActivityType,
} from './activity.types';

type JsonObject = Record<string, unknown>;
export type ActivityOwnerPrincipal = InvoiceMerchantPrincipal;

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);
  private readonly syncFlights = new Map<
    string,
    Promise<ActivitySyncResult>
  >();
  private static readonly WALLET_SOURCE = 'external_wallet' as const;
  private static readonly SYNC_THROTTLE_MS = 60_000;
  private static readonly SYNC_LEASE_MS = 120_000;
  private static readonly READ_SESSION_MS = 12 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async authenticateRead(authorization?: string): Promise<ActivityOwnerPrincipal> {
    const token = this.bearerToken(authorization);
    const session = await this.prisma.activityAuthSession.findFirst({
      where: {
        sessionHash: this.sessionHash(token),
        expiresAt: { gt: new Date() },
      },
    });
    if (!session)
      throw new UnauthorizedException({
        code: 'ACTIVITY_SESSION_REQUIRED',
        message: 'Synchronize activity once for this authenticated session.',
      });
    return {
      merchantUserId: session.ownerUserId,
      merchantWalletAddress: getAddress(session.walletAddress),
      merchantDisplayLabel: null,
    };
  }

  async sync(
    principal: ActivityOwnerPrincipal,
  ): Promise<ActivitySyncResult> {
    const key = `${principal.merchantUserId}:${ActivityService.WALLET_SOURCE}`;
    const current = this.syncFlights.get(key);
    if (current) return current;
    const flight = this.runSyncWithReadSession(principal).finally(() => {
      if (this.syncFlights.get(key) === flight) this.syncFlights.delete(key);
    });
    this.syncFlights.set(key, flight);
    return flight;
  }

  async list(
    principal: ActivityOwnerPrincipal,
    input: { cursor?: string; limit?: number; type?: string; status?: string },
  ) {
    this.validateListInput(input);
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 50);
    const type = this.optionalType(input.type);
    const status = this.optionalStatus(input.status);
    const cursor = input.cursor ? this.decodeCursor(input.cursor) : null;
    const rows = await this.prisma.activity.findMany({
      where: {
        ownerUserId: principal.merchantUserId,
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => this.toPublic(row)),
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({
                createdAt: last.createdAt.toISOString(),
                id: last.id,
              }),
            ).toString('base64url')
          : null,
    };
  }

  validateListInput(input: {
    cursor?: string;
    limit?: number;
    type?: string;
    status?: string;
  }) {
    if (
      input.limit !== undefined &&
      (!Number.isInteger(input.limit) || input.limit < 1)
    )
      throw new Error('Invalid activity page size.');
    this.optionalType(input.type);
    this.optionalStatus(input.status);
    if (input.cursor) this.decodeCursor(input.cursor);
  }

  async getOwned(principal: ActivityOwnerPrincipal, id: string) {
    const row = await this.prisma.activity.findFirst({
      where: { id, ownerUserId: principal.merchantUserId },
    });
    if (!row) throw new NotFoundException('Activity not found.');
    return this.toPublic(row);
  }

  async upsert(projection: ActivityProjection) {
    const walletAddress = getAddress(projection.walletAddress).toLowerCase();
    const immutable = {
      ownerUserId: projection.ownerUserId,
      walletAddress,
      idempotencyKey: projection.idempotencyKey,
      sourceReferenceType: projection.sourceReferenceType,
      sourceReferenceId: projection.sourceReferenceId,
    };
    const existing = await this.prisma.activity.findUnique({
      where: { idempotencyKey: projection.idempotencyKey },
    });
    const mutable = {
      type: projection.type,
      direction: projection.direction,
      status: this.progressedStatus(existing?.status, projection.status),
      source: projection.source,
      taskId: projection.taskId,
      operationId: projection.operationId,
      challengeId: projection.challengeId,
      transactionId: projection.transactionId,
      chainId: projection.chainId,
      txHash: projection.txHash?.toLowerCase(),
      inputTokenSymbol: projection.inputTokenSymbol,
      inputTokenAddress: this.normalizedOptionalAddress(
        projection.inputTokenAddress,
      ),
      inputAmount: projection.inputAmount,
      outputTokenSymbol: projection.outputTokenSymbol,
      outputTokenAddress: this.normalizedOptionalAddress(
        projection.outputTokenAddress,
      ),
      outputAmount: projection.outputAmount,
      feeAmount: projection.feeAmount,
      feeTokenSymbol: projection.feeTokenSymbol,
      counterparty: this.normalizedOptionalAddress(projection.counterparty),
      metadata: this.safeMetadata(projection.metadata) as
        | Prisma.InputJsonValue
        | undefined,
      occurredAt: projection.occurredAt,
    };
    if (
      existing &&
      (existing.ownerUserId !== immutable.ownerUserId ||
        existing.walletAddress !== immutable.walletAddress ||
        existing.sourceReferenceType !== immutable.sourceReferenceType ||
        existing.sourceReferenceId !== immutable.sourceReferenceId)
    ) {
      throw new Error('Activity idempotency ownership conflict.');
    }
    return this.prisma.activity.upsert({
      where: { idempotencyKey: projection.idempotencyKey },
      create: { ...immutable, ...mutable },
      update: mutable,
    });
  }

  private async runSyncWithReadSession(
    principal: ActivityOwnerPrincipal,
  ): Promise<ActivitySyncResult> {
    const readSessionToken = await this.registerReadSession(principal);
    return {
      ...(await this.runSync(principal)),
      readSessionToken,
    };
  }

  private async registerReadSession(
    principal: ActivityOwnerPrincipal,
  ): Promise<string> {
    // The external-wallet bearer proves ownership only while synchronizing.
    // Reads use a separate 256-bit opaque token, stored solely as a
    // SHA-256 fingerprint.
    const readSessionToken = randomBytes(32).toString('base64url');
    const ownerUserId = principal.merchantUserId;
    const walletAddress = getAddress(principal.merchantWalletAddress).toLowerCase();
    await this.prisma.activityAuthSession.deleteMany({
      where: { ownerUserId },
    });
    await this.prisma.activityAuthSession.create({
      data: {
        sessionHash: this.sessionHash(readSessionToken),
        ownerUserId,
        walletAddress,
        expiresAt: new Date(Date.now() + ActivityService.READ_SESSION_MS),
      },
    });
    return readSessionToken;
  }

  private async runSync(
    principal: ActivityOwnerPrincipal,
  ): Promise<ActivitySyncSummary> {
    const source = ActivityService.WALLET_SOURCE;
    const now = new Date();
    const walletAddress = getAddress(
      principal.merchantWalletAddress,
    ).toLowerCase();
    const state = await this.prisma.activitySyncState.upsert({
      where: {
        ownerUserId_source: {
          ownerUserId: principal.merchantUserId,
          source,
        },
      },
      create: {
        ownerUserId: principal.merchantUserId,
        walletAddress,
        source,
      },
      update: {},
    });
    if (state.walletAddress !== walletAddress)
      throw new UnauthorizedException('Activity sync ownership conflict.');

    if (state.nextAllowedAt && state.nextAllowedAt > now) {
      return this.emptySyncSummary(
        'throttled',
        state.nextAllowedAt.getTime() - now.getTime(),
      );
    }

    const leaseId = randomUUID();
    const leaseExpiresAt = new Date(
      now.getTime() + ActivityService.SYNC_LEASE_MS,
    );
    const claimed = await this.prisma.activitySyncState.updateMany({
      where: {
        id: state.id,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
        AND: [
          {
            OR: [{ nextAllowedAt: null }, { nextAllowedAt: { lte: now } }],
          },
        ],
      },
      data: { leaseId, leaseExpiresAt, lastStartedAt: now },
    });
    if (claimed.count !== 1) {
      const current = await this.prisma.activitySyncState.findUnique({
        where: { id: state.id },
      });
      const throttledUntil = current?.nextAllowedAt;
      if (throttledUntil && throttledUntil > now)
        return this.emptySyncSummary(
          'throttled',
          throttledUntil.getTime() - now.getTime(),
        );
      return this.emptySyncSummary(
        'in_flight',
        Math.max(
          1_000,
          (current?.leaseExpiresAt?.getTime() ?? leaseExpiresAt.getTime()) -
            now.getTime(),
        ),
      );
    }

    try {
      const recordsAccepted = await this.projectPersisted(principal);
      const completedAt = new Date();
      await this.prisma.activitySyncState.updateMany({
        where: { id: state.id, leaseId },
        data: {
          leaseId: null,
          leaseExpiresAt: null,
          lastCompletedAt: completedAt,
          nextAllowedAt: new Date(
            completedAt.getTime() + ActivityService.SYNC_THROTTLE_MS,
          ),
        },
      });
      return {
        source,
        status: 'synced',
        pagesScanned: 0,
        recordsScanned: 0,
        recordsAccepted,
        checkpointAdvanced: false,
        retryAfterMs: ActivityService.SYNC_THROTTLE_MS,
      };
    } catch {
      const failedAt = new Date();
      await this.prisma.activitySyncState.updateMany({
        where: { id: state.id, leaseId },
        data: {
          leaseId: null,
          leaseExpiresAt: null,
          nextAllowedAt: new Date(
            failedAt.getTime() + ActivityService.SYNC_THROTTLE_MS,
          ),
        },
      });
      this.logger.warn('External wallet activity synchronization deferred.');
      return this.emptySyncSummary(
        'failed',
        ActivityService.SYNC_THROTTLE_MS,
      );
    }
  }

  private emptySyncSummary(
    status: ActivitySyncSummary['status'],
    retryAfterMs: number,
  ): ActivitySyncSummary {
    return {
      source: ActivityService.WALLET_SOURCE,
      status,
      pagesScanned: 0,
      recordsScanned: 0,
      recordsAccepted: 0,
      checkpointAdvanced: false,
      retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)),
    };
  }

  /**
   * Project Mainnet direct activity from backend-verified records only.
   *
   * On Arc Mainnet the backend observes transfers exclusively through its
   * own receipt verification (invoice payments settled to the merchant
   * wallet). There is no provider enrichment: every projection below is
   * anchored to a verified on-chain receipt on chain 5042.
   */
  async projectPersisted(principal: ActivityOwnerPrincipal): Promise<number> {
    const payments = await this.prisma.invoicePayment.findMany({
      where: {
        status: 'VERIFIED',
        invoice: { merchantUserId: principal.merchantUserId },
      },
      include: { invoice: true },
    });

    let accepted = 0;
    for (const payment of payments) {
      const invoice = payment.invoice;
      if (
        !this.sameWallet(
          invoice.merchantWalletAddress,
          principal.merchantWalletAddress,
        )
      )
        continue;
      if (invoice.chainId !== ARC_MAINNET_CHAIN_ID) continue;
      await this.upsert({
        ownerUserId: principal.merchantUserId,
        walletAddress: principal.merchantWalletAddress,
        type: 'invoice_payment',
        direction: 'incoming',
        status: 'completed',
        source: 'invoice_receipt',
        idempotencyKey: `invoice-payment:${payment.id}`,
        sourceReferenceType: 'invoice_payment',
        sourceReferenceId: payment.id,
        transactionId: payment.id,
        chainId: invoice.chainId,
        txHash: payment.transactionHash,
        outputTokenSymbol: invoice.tokenSymbol,
        outputTokenAddress: invoice.tokenAddress,
        outputAmount: invoice.amountUnits,
        counterparty: payment.payerAddress ?? undefined,
        metadata: { invoicePublicId: invoice.publicId },
        occurredAt: payment.verifiedAt ?? payment.createdAt,
      });
      accepted += 1;
    }
    return accepted;
  }

  private toPublic(row: Activity) {
    return {
      id: row.id,
      type: row.type,
      direction: row.direction,
      status: row.status,
      source: row.source,
      sourceReferenceType: row.sourceReferenceType,
      sourceReferenceId: row.sourceReferenceId,
      taskId: row.taskId,
      operationId: row.operationId,
      challengeId: row.challengeId,
      transactionId: row.transactionId,
      chainId: row.chainId,
      txHash: row.txHash,
      inputTokenSymbol: row.inputTokenSymbol,
      inputTokenAddress: row.inputTokenAddress,
      inputAmount: row.inputAmount,
      outputTokenSymbol: row.outputTokenSymbol,
      outputTokenAddress: row.outputTokenAddress,
      outputAmount: row.outputAmount,
      feeAmount: row.feeAmount,
      feeTokenSymbol: row.feeTokenSymbol,
      counterparty: row.counterparty,
      metadata: this.safeMetadata(this.object(row.metadata)),
      occurredAt: row.occurredAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private progressedStatus(
    current: string | undefined,
    next: ActivityStatus,
  ): ActivityStatus {
    if (!current || current === next) return next;
    if (current === 'completed') return 'completed';
    const terminal = ['failed', 'expired', 'cancelled'];
    if (terminal.includes(current) && next !== 'completed')
      return current as ActivityStatus;
    const rank: Record<ActivityStatus, number> = {
      pending: 0,
      submitted: 1,
      confirming: 2,
      recovery_required: 3,
      failed: 4,
      expired: 4,
      cancelled: 4,
      completed: 5,
    };
    return rank[next] >= (rank[current as ActivityStatus] ?? 0)
      ? next
      : (current as ActivityStatus);
  }
  private optionalType(value?: string): ActivityType | undefined {
    if (!value) return undefined;
    if (!(ACTIVITY_TYPES as readonly string[]).includes(value))
      throw new Error('Invalid activity type filter.');
    return value as ActivityType;
  }
  private optionalStatus(value?: string): ActivityStatus | undefined {
    if (!value) return undefined;
    if (!(ACTIVITY_STATUSES as readonly string[]).includes(value))
      throw new Error('Invalid activity status filter.');
    return value as ActivityStatus;
  }
  private decodeCursor(value: string) {
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as {
        createdAt?: string;
        id?: string;
      };
      const createdAt = new Date(parsed.createdAt ?? '');
      if (!parsed.id || Number.isNaN(createdAt.getTime())) throw new Error();
      return { createdAt, id: parsed.id };
    } catch {
      throw new Error('Invalid activity cursor.');
    }
  }
  private object(value: unknown): JsonObject {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as JsonObject)
      : {};
  }
  private sameWallet(left: string, right: string) {
    return (
      isAddress(left) &&
      isAddress(right) &&
      isAddressEqual(getAddress(left), getAddress(right))
    );
  }
  private normalizedOptionalAddress(value?: string) {
    return value && isAddress(value)
      ? getAddress(value).toLowerCase()
      : undefined;
  }
  private safeMetadata(value?: Record<string, unknown>) {
    if (!value) return undefined;
    const allowed = [
      'invoicePublicId',
      'transactionCount',
      'sourceChainId',
      'destinationChainId',
    ];
    return Object.fromEntries(
      allowed.flatMap((key) => {
        const item = value[key];
        return typeof item === 'string' ||
          typeof item === 'number' ||
          typeof item === 'boolean'
          ? [[key, item]]
          : [];
      }),
    );
  }

  private bearerToken(authorization?: string) {
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match)
      throw new UnauthorizedException({
        code: 'ACTIVITY_AUTH_REQUIRED',
        message: 'An authenticated activity session is required.',
      });
    return match[1];
  }

  private sessionHash(token: string) {
    return createHash('sha256')
      .update('wizpay.activity.read.v1\0')
      .update(token)
      .digest('hex');
  }
}
