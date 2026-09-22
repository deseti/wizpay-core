import { Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma, type Activity } from '@prisma/client';
import { getAddress, isAddress, isAddressEqual } from 'viem';
import { PrismaService } from '../database/prisma.service';
import type { InvoiceMerchantPrincipal } from '../invoice/invoice.types';
import { ARC_MAINNET_CHAIN_ID } from '../config/arc-network.config';
import {
  ARC_MAINNET_UNISWAP_V4_EURC,
  ARC_MAINNET_UNISWAP_V4_USDC,
} from '../user-swap/mainnet-uniswap-v4-protocol';
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

  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async sync(
    principal: ActivityOwnerPrincipal,
  ): Promise<ActivitySyncResult> {
    const key = `${principal.merchantUserId}:${this.canonicalWallet(principal.merchantWalletAddress)}:${ActivityService.WALLET_SOURCE}`;
    const current = this.syncFlights.get(key);
    if (current) return current;
    const flight = this.runSync(principal).finally(() => {
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
    const walletAddress = this.canonicalWallet(principal.merchantWalletAddress);
    const rows = await this.prisma.activity.findMany({
      where: {
        ownerUserId: principal.merchantUserId,
        walletAddress,
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
      where: {
        id,
        ownerUserId: principal.merchantUserId,
        walletAddress: this.canonicalWallet(principal.merchantWalletAddress),
      },
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
      const recordsAccepted = await this.projectPersisted(principal);
      return {
        ...this.emptySyncSummary(
          'throttled',
          state.nextAllowedAt.getTime() - now.getTime(),
        ),
        recordsAccepted,
      };
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
    const wallet = getAddress(principal.merchantWalletAddress);
    const [payments, intents, bridges, swaps] = await Promise.all([
      this.prisma.invoicePayment.findMany({
        where: {
          status: 'VERIFIED',
          invoice: { merchantUserId: principal.merchantUserId },
        },
        include: { invoice: true },
      }),
      this.prisma.executionIntent.findMany({
        where: {
          status: 'COMPLETED',
          network: 'arc-mainnet',
          transactionHash: { not: null },
          operation: { in: ['SEND', 'PAYROLL'] },
        },
      }),
      this.prisma.bridgeTransaction.findMany({ where: { status: 'completed' } }),
      this.prisma.verifiedSwapTransaction.findMany({
        where: { chainId: ARC_MAINNET_CHAIN_ID },
      }),
    ]);

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

    for (const intent of intents) {
      if (intent.network !== 'arc-mainnet' || !intent.transactionHash) continue;
      if (!this.sameWallet(intent.sourceWallet, wallet)) continue;
      if (intent.operation !== 'SEND') continue;
      await this.upsert({
        ownerUserId: principal.merchantUserId,
        walletAddress: wallet,
        type: 'send',
        direction: 'outgoing',
        status: 'completed',
        source: 'verified_execution_intent',
        idempotencyKey: `execution-intent:${intent.id}`,
        sourceReferenceType: 'execution_intent',
        sourceReferenceId: intent.id,
        operationId: intent.id,
        chainId: ARC_MAINNET_CHAIN_ID,
        txHash: intent.transactionHash,
        inputTokenSymbol: this.tokenSymbol(intent.tokenOut),
        inputTokenAddress: intent.tokenOut,
        inputAmount: intent.amountUnits,
        counterparty: intent.recipient ?? undefined,
        metadata: { referenceId: intent.externalReference },
        occurredAt: intent.completedAt ?? intent.updatedAt,
      });
      accepted += 1;
    }

    const payrollIntents = intents.filter(
      (intent) =>
        intent.network === 'arc-mainnet' &&
        intent.operation === 'PAYROLL' &&
        Boolean(intent.transactionHash) &&
        this.sameWallet(intent.sourceWallet, wallet),
    );
    const taskIds = [
      ...new Set(
        payrollIntents.flatMap((intent) => (intent.taskId ? [intent.taskId] : [])),
      ),
    ];
    const tasks = taskIds.length
      ? await this.prisma.task.findMany({ where: { id: { in: taskIds } } })
      : [];
    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const refs = new Set(payrollIntents.map((intent) => intent.externalReference));
    const payrollRuns = new Map<string, typeof payrollIntents>();
    for (const intent of payrollIntents) {
      const task = intent.taskId ? tasksById.get(intent.taskId) : undefined;
      const runReference =
        this.metadataString(task?.metadata, 'runReferenceId') ??
        this.payrollRunReference(intent.externalReference, refs);
      const run = payrollRuns.get(runReference) ?? [];
      run.push(intent);
      payrollRuns.set(runReference, run);
    }
    for (const [runReference, run] of payrollRuns) {
      const uniqueTasks = new Map(
        run.flatMap((intent) => {
          const task = intent.taskId ? tasksById.get(intent.taskId) : undefined;
          return task ? [[task.id, task] as const] : [];
        }),
      );
      const recipientCount = [...uniqueTasks.values()].reduce(
        (sum, task) => sum + this.metadataNumber(task.metadata, 'totalRecipients'),
        0,
      );
      const tokenTotals = new Map<string, { address: string; amount: bigint }>();
      for (const intent of run) {
        const symbol = this.tokenSymbol(intent.tokenOut);
        const current = tokenTotals.get(symbol) ?? {
          address: intent.tokenOut,
          amount: 0n,
        };
        current.amount += BigInt(intent.amountUnits);
        tokenTotals.set(symbol, current);
      }
      const hashes = [
        ...new Set(
          run.flatMap((intent) =>
            intent.transactionHash ? [intent.transactionHash.toLowerCase()] : [],
          ),
        ),
      ];
      const single = tokenTotals.size === 1 ? [...tokenTotals.entries()][0] : null;
      const occurredAt = run.reduce(
        (latest, intent) => {
          const value = intent.completedAt ?? intent.updatedAt;
          return value > latest ? value : latest;
        },
        new Date(0),
      );
      const sourceReferenceId = `${wallet.toLowerCase()}:${runReference}`;
      await this.upsert({
        ownerUserId: principal.merchantUserId,
        walletAddress: wallet,
        type: 'payroll',
        direction: 'outgoing',
        status: 'completed',
        source: 'verified_payroll_intents',
        idempotencyKey: `payroll-run:${sourceReferenceId}`,
        sourceReferenceType: 'payroll_run',
        sourceReferenceId,
        taskId: run[0]?.taskId ?? undefined,
        chainId: ARC_MAINNET_CHAIN_ID,
        txHash: hashes[0],
        inputTokenSymbol: single?.[0],
        inputTokenAddress: single?.[1].address,
        inputAmount: single?.[1].amount.toString(),
        metadata: {
          referenceId: runReference,
          transactionCount: recipientCount,
          transactionHashes: hashes,
          tokenTotals: Object.fromEntries(
            [...tokenTotals].map(([symbol, total]) => [symbol, total.amount.toString()]),
          ),
        },
        occurredAt,
      });
      accepted += 1;
    }

    for (const swap of swaps) {
      if (!this.sameWallet(swap.walletAddress, wallet)) continue;
      await this.upsert({
        ownerUserId: principal.merchantUserId,
        walletAddress: wallet,
        type: 'swap',
        direction: 'outgoing',
        status: 'completed',
        source: 'verified_swap_receipt',
        idempotencyKey: `verified-swap:${swap.id}`,
        sourceReferenceType: 'verified_swap',
        sourceReferenceId: swap.id,
        transactionId: swap.id,
        chainId: swap.chainId,
        txHash: swap.transactionHash,
        inputTokenSymbol: this.tokenSymbol(swap.tokenIn),
        inputTokenAddress: swap.tokenIn,
        inputAmount: swap.amountIn,
        outputTokenSymbol: this.tokenSymbol(swap.tokenOut),
        outputTokenAddress: swap.tokenOut,
        outputAmount: swap.amountOut,
        occurredAt: swap.completedAt,
      });
      accepted += 1;
    }

    for (const bridge of bridges) {
      const payload = this.object(bridge.payload);
      const result = this.object(bridge.result);
      const bridgeWallet = this.string(payload.walletAddress);
      const destinationHash = this.string(result.destinationTransactionHash);
      if (
        result.destinationReceiptVerified !== true ||
        !bridgeWallet ||
        !destinationHash ||
        !this.sameWallet(bridgeWallet, wallet)
      ) {
        continue;
      }
      await this.upsert({
        ownerUserId: principal.merchantUserId,
        walletAddress: wallet,
        type: 'bridge',
        direction: 'outgoing',
        status: 'completed',
        source: 'completed_cctp_intent',
        idempotencyKey: `bridge:${bridge.id}`,
        sourceReferenceType: 'bridge_transaction',
        sourceReferenceId: bridge.id,
        taskId: bridge.taskId,
        operationId: bridge.id,
        chainId: this.number(payload.sourceChainId),
        txHash: destinationHash,
        inputTokenSymbol: 'USDC',
        inputTokenAddress: this.string(payload.sourceUsdcAddress),
        inputAmount: this.string(payload.amount),
        outputTokenSymbol: 'USDC',
        outputTokenAddress: this.string(payload.destinationUsdcAddress),
        outputAmount: this.string(result.mintAmount) ?? this.string(payload.amount),
        counterparty: this.string(payload.recipientAddress),
        metadata: {
          sourceChainId: this.number(payload.sourceChainId) ?? 0,
          destinationChainId: this.number(payload.destinationChainId) ?? 0,
          transactionHashes: [
            this.string(result.sourceTransactionHash),
            destinationHash,
          ].filter((value): value is string => Boolean(value)),
        },
        occurredAt: this.date(result.completedAt) ?? bridge.updatedAt,
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
  private canonicalWallet(value: string) {
    return getAddress(value).toLowerCase();
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
      'referenceId',
      'transactionHashes',
      'tokenTotals',
    ];
    const safe: Record<string, unknown> = {};
    for (const key of allowed) {
      const item = value[key];
      if (
        typeof item === 'string' ||
        typeof item === 'number' ||
        typeof item === 'boolean' ||
        (Array.isArray(item) &&
          item.every((child) => typeof child === 'string')) ||
        (item &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          Object.values(item).every((child) => typeof child === 'string'))
      ) {
        safe[key] = item;
      }
    }
    return safe;
  }

  private payrollRunReference(reference: string, all: Set<string>) {
    const match = reference.match(/^(.*)-(USDC|EURC)(?:-\d+)?$/);
    if (!match) return reference.replace(/-\d+$/, '');
    const base = match[1];
    const other = match[2] === 'USDC' ? 'EURC' : 'USDC';
    const hasSibling = [...all].some((candidate) =>
      new RegExp(`^${this.escapeRegex(base)}-${other}(?:-\\d+)?$`).test(candidate),
    );
    return hasSibling ? base : reference.replace(/-\d+$/, '');
  }

  private escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private tokenSymbol(address: string) {
    if (this.sameWallet(address, ARC_MAINNET_UNISWAP_V4_USDC)) return 'USDC';
    if (this.sameWallet(address, ARC_MAINNET_UNISWAP_V4_EURC)) return 'EURC';
    return 'Token';
  }

  private metadataNumber(value: unknown, key: string) {
    const item = this.object(value)[key];
    return typeof item === 'number' && Number.isSafeInteger(item) && item >= 0
      ? item
      : 0;
  }

  private metadataString(value: unknown, key: string) {
    const item = this.object(value)[key];
    return typeof item === 'string' && item ? item : undefined;
  }

  private string(value: unknown) {
    return typeof value === 'string' && value ? value : undefined;
  }

  private number(value: unknown) {
    return typeof value === 'number' && Number.isSafeInteger(value)
      ? value
      : undefined;
  }

  private date(value: unknown) {
    if (typeof value !== 'string') return undefined;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  }

}
