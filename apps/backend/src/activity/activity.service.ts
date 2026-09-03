import {
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  Prisma,
  type Activity,
  type AppWalletXylonetOperation,
  type Task,
  type TaskTransaction,
  type TaskUnit,
} from '@prisma/client';
import { getAddress, isAddress, isAddressEqual } from 'viem';
import { PrismaService } from '../database/prisma.service';
import type { AuthenticatedCirclePrincipal } from '../invoice/invoice-auth.service';
import { W3sAuthService } from '../modules/wallet/w3s-auth.service';
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
type TaskWithRows = Task & {
  transactions: TaskTransaction[];
  units: TaskUnit[];
};
type ActivityOwnerPrincipal = Pick<
  AuthenticatedCirclePrincipal,
  'merchantUserId' | 'merchantWalletAddress'
>;

const ARC_TOKENS: Record<string, { symbol: 'USDC' | 'EURC'; decimals: 6 }> = {
  '0x3600000000000000000000000000000000000000': { symbol: 'USDC', decimals: 6 },
  '0x89b50855aa3be2f677cd6303cec089b5f319d72a': { symbol: 'EURC', decimals: 6 },
};

@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);
  private readonly syncFlights = new Map<
    string,
    Promise<ActivitySyncResult>
  >();
  private static readonly CIRCLE_SOURCE = 'circle_w3s' as const;
  private static readonly SYNC_THROTTLE_MS = 60_000;
  private static readonly SYNC_LEASE_MS = 120_000;
  private static readonly READ_SESSION_MS = 12 * 60 * 60 * 1000;
  private static readonly MAX_CIRCLE_PAGES = 3;
  private static readonly MAX_CIRCLE_RECORDS = 150;
  private readonly tokenMetadataFlights = new Map<string, Promise<Map<string, { symbol: string; address: string }>>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly w3s: W3sAuthService,
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
    };
  }

  async sync(
    principal: AuthenticatedCirclePrincipal,
  ): Promise<ActivitySyncResult> {
    const key = `${principal.merchantUserId}:${ActivityService.CIRCLE_SOURCE}`;
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
    principal: AuthenticatedCirclePrincipal,
  ): Promise<ActivitySyncResult> {
    const readSessionToken = await this.registerReadSession(principal);
    return {
      ...(await this.runSync(principal)),
      readSessionToken,
    };
  }

  private async registerReadSession(
    principal: AuthenticatedCirclePrincipal,
  ): Promise<string> {
    // A Circle bearer proves ownership only while synchronizing.  Reads use a
    // separate 256-bit opaque token, stored solely as a SHA-256 fingerprint.
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
    principal: AuthenticatedCirclePrincipal,
  ): Promise<ActivitySyncSummary> {
    const source = ActivityService.CIRCLE_SOURCE;
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
      await this.projectPersisted(principal);
      const result = await this.projectCircle(
        principal,
        state.checkpointTransactionId ?? undefined,
      );
      const completedAt = new Date();
      await this.prisma.activitySyncState.updateMany({
        where: { id: state.id, leaseId },
        data: {
          checkpointTransactionId:
            result.checkpointTransactionId ??
            state.checkpointTransactionId ??
            null,
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
        pagesScanned: result.pagesScanned,
        recordsScanned: result.recordsScanned,
        recordsAccepted: result.recordsAccepted,
        checkpointAdvanced:
          Boolean(result.checkpointTransactionId) &&
          result.checkpointTransactionId !== state.checkpointTransactionId,
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
      this.logger.warn('Circle activity synchronization deferred.');
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
      source: ActivityService.CIRCLE_SOURCE,
      status,
      pagesScanned: 0,
      recordsScanned: 0,
      recordsAccepted: 0,
      checkpointAdvanced: false,
      retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)),
    };
  }

  async projectPersisted(principal: ActivityOwnerPrincipal) {
    const [swaps, invoices, tasks] = await Promise.all([
      this.prisma.appWalletXylonetOperation.findMany({
        where: { applicationUserId: principal.merchantUserId },
      }),
      this.prisma.invoicePayment.findMany({
        where: {
          status: 'VERIFIED',
          invoice: { merchantUserId: principal.merchantUserId },
        },
        include: { invoice: true },
      }),
      this.prisma.task.findMany({
        where: { type: 'bridge' },
        include: { transactions: true, units: true },
      }),
    ]);

    for (const operation of swaps) {
      if (
        !this.sameWallet(
          operation.walletAddress,
          principal.merchantWalletAddress,
        )
      )
        continue;
      await this.projectVerifiedXylonetOperation(operation);
    }

    for (const payment of invoices) {
      const invoice = payment.invoice;
      if (
        !this.sameWallet(
          invoice.merchantWalletAddress,
          principal.merchantWalletAddress,
        )
      )
        continue;
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
    }

    const taskOwnershipUnambiguous =
      await this.canonicalOwnerIsUnambiguous(principal);
    for (const task of tasks) {
      if (!taskOwnershipUnambiguous) continue;
      const owner = this.taskOwner(task.metadata, task.payload);
      if (!owner || !this.sameWallet(owner, principal.merchantWalletAddress))
        continue;
      if (task.type === 'bridge') await this.projectBridge(principal, task);
    }
  }

  /** Project only an operation whose backend receipt verification made it final. */
  async projectVerifiedXylonetOperation(
    operation: AppWalletXylonetOperation,
  ): Promise<void> {
    if (
      operation.lifecycleStage !== 'completed' ||
      operation.terminalStatus !== 'confirmed'
    )
      return;
    await this.upsert({
      ownerUserId: operation.applicationUserId,
      walletAddress: operation.walletAddress,
      type: 'swap',
      direction: 'outgoing',
      status: 'completed',
      source: 'xylonet_tower',
      idempotencyKey: `xylonet:${operation.operationId}`,
      sourceReferenceType: 'app_wallet_xylonet_operation',
      sourceReferenceId: operation.operationId,
      operationId: operation.operationId,
      challengeId: operation.swapChallengeId ?? undefined,
      transactionId: operation.swapTransactionId ?? undefined,
      chainId: operation.chainId,
      txHash: operation.swapTransactionHash ?? undefined,
      inputTokenSymbol: operation.tokenIn,
      inputTokenAddress: operation.tokenInAddress,
      inputAmount: operation.amountIn,
      outputTokenSymbol: operation.tokenOut,
      outputTokenAddress: operation.tokenOutAddress,
      outputAmount: operation.expectedOutput,
      counterparty: operation.executorAddress,
      occurredAt: operation.completedAt ?? operation.createdAt,
    });
  }

  private async projectPayroll(
    principal: ActivityOwnerPrincipal,
    task: TaskWithRows,
  ) {
    const metadata = this.object(task.metadata);
    const payload = this.object(task.payload);
    const hashes = [...task.transactions, ...task.units]
      .map((row: { txHash?: string | null }) => row.txHash)
      .filter((hash: unknown): hash is string => this.isTxHash(hash));
    const providerRows = task.transactions as Array<{ status: string }>;
    if (!hashes.length && !providerRows.length) return;
    await this.upsert({
      ownerUserId: principal.merchantUserId,
      walletAddress: principal.merchantWalletAddress,
      type: 'payroll',
      direction: 'outgoing',
      status: this.taskStatus(task.status),
      source: 'payroll_task',
      idempotencyKey: `task:${task.id}`,
      sourceReferenceType: 'task',
      sourceReferenceId: task.id,
      taskId: task.id,
      chainId: 5042002,
      txHash: hashes[0],
      inputTokenSymbol:
        this.string(metadata.sourceToken) ?? this.string(payload.sourceToken),
      inputAmount:
        this.string(metadata.totalAmount) ?? this.string(payload.totalAmount),
      metadata: {
        transactionCount: Math.max(hashes.length, providerRows.length),
      },
      occurredAt: task.updatedAt,
    });
  }

  private async projectBridge(
    principal: ActivityOwnerPrincipal,
    task: TaskWithRows,
  ) {
    const bridge = await this.prisma.bridgeTransaction.findUnique({
      where: { taskId: task.id },
    });
    if (!bridge) return;
    const payload = this.object(bridge.payload);
    const result = this.object(bridge.result);
    const sourceHash = this.string(result.sourceTransactionHash);
    if (!sourceHash) return; // reportSource verifies signer, CCTP event, token and amount.
    await this.upsert({
      ownerUserId: principal.merchantUserId,
      walletAddress: principal.merchantWalletAddress,
      type: 'bridge',
      direction: 'outgoing',
      status: bridge.status === 'completed' ? 'completed' : 'confirming',
      source: 'circle_cctp_v2',
      idempotencyKey: `bridge:${bridge.id}`,
      sourceReferenceType: 'bridge_transaction',
      sourceReferenceId: bridge.id,
      taskId: task.id,
      operationId: bridge.id,
      chainId: this.number(payload.sourceChainId),
      txHash: sourceHash,
      inputTokenSymbol: 'USDC',
      inputTokenAddress: this.string(payload.sourceUsdcAddress),
      inputAmount: this.string(payload.amount),
      outputTokenSymbol: 'USDC',
      outputTokenAddress: this.string(payload.destinationUsdcAddress),
      outputAmount:
        this.string(result.mintAmount) ?? this.string(payload.amount),
      feeAmount: this.string(result.feeExecuted),
      counterparty: this.string(payload.recipientAddress),
      metadata: {
        sourceChainId: this.number(payload.sourceChainId) ?? 0,
        destinationChainId: this.number(payload.destinationChainId) ?? 0,
      },
      occurredAt: bridge.updatedAt,
    });
  }

  private async projectCircle(
    principal: AuthenticatedCirclePrincipal,
    checkpointTransactionId?: string,
  ) {
    const tokenMetadata = await this.resolveCircleTokenMetadata(principal);
    await this.enrichStoredCircleActivities(principal, tokenMetadata);
    let pageAfter = checkpointTransactionId;
    const allTransactions: unknown[] = [];
    const seenIds = new Set<string>();
    let pagesScanned = 0;
    let recordsScanned = 0;
    let nextCheckpoint = checkpointTransactionId;
    for (let page = 0; page < ActivityService.MAX_CIRCLE_PAGES; page += 1) {
      const response = await this.w3s.listUserTransactions(
        { walletId: principal.circleWalletId, pageAfter },
        principal.userToken,
      );
      const transactions = this.circleTransactions(response);
      pagesScanned += 1;
      recordsScanned += transactions.length;
      for (const transaction of transactions) {
        const id = this.string(this.object(transaction).id);
        if (!id || seenIds.has(id) || id === checkpointTransactionId) continue;
        seenIds.add(id);
        allTransactions.push(transaction);
      }
      if (transactions.length < 50) break;
      const lastId = this.string(this.object(transactions.at(-1)).id);
      if (!lastId || lastId === pageAfter) break;
      pageAfter = lastId;
      nextCheckpoint = lastId;
      if (recordsScanned >= ActivityService.MAX_CIRCLE_RECORDS) break;
      if (page === ActivityService.MAX_CIRCLE_PAGES - 1)
        this.logger.warn(
          'Circle activity reconciliation reached its bounded pagination limit.',
        );
    }
    const lastAcceptedId = this.string(
      this.object(allTransactions.at(-1)).id,
    );
    nextCheckpoint = lastAcceptedId ?? nextCheckpoint;
    const payrollTransactionIds = await this.projectCirclePayroll(
      principal,
      allTransactions,
    );
    const transferCount = await this.projectCircleTransactions(
      principal,
      allTransactions,
      payrollTransactionIds,
      tokenMetadata,
    );
    return {
      pagesScanned,
      recordsScanned,
      recordsAccepted: payrollTransactionIds.size + transferCount,
      checkpointTransactionId: nextCheckpoint,
    };
  }

  private async enrichStoredCircleActivities(
    principal: AuthenticatedCirclePrincipal,
    metadata: Map<string, { symbol: string; address: string }>,
  ): Promise<void> {
    if (!metadata.size) return;
    const rows = await this.prisma.activity.findMany({
      where: { ownerUserId: principal.merchantUserId, source: 'circle_w3s' },
      take: 100,
      orderBy: { createdAt: 'desc' },
    });
    for (const row of rows) {
      const tokenId = this.string(this.object(row.metadata).circleTokenId);
      const token = tokenId ? metadata.get(tokenId) : undefined;
      if (!token || (row.inputTokenSymbol || row.outputTokenSymbol)) continue;
      await this.prisma.activity.update({
        where: { id: row.id },
        data: row.direction === 'incoming'
          ? { outputTokenSymbol: token.symbol, outputTokenAddress: token.address }
          : { inputTokenSymbol: token.symbol, inputTokenAddress: token.address },
      });
    }
  }

  private async resolveCircleTokenMetadata(principal: AuthenticatedCirclePrincipal) {
    const key = `${principal.merchantUserId}:${principal.circleWalletId}`;
    const current = this.tokenMetadataFlights.get(key);
    if (current) return current;
    const flight = (async () => {
      if (typeof this.w3s.listUserTokenBalances !== 'function') return new Map<string, { symbol: string; address: string }>();
      const response = await this.w3s.listUserTokenBalances(principal.circleWalletId, principal.userToken);
      const balanceRows = this.object(response).tokenBalances;
      const rows: unknown[] = Array.isArray(balanceRows) ? balanceRows : [];
      const metadata = new Map<string, { symbol: string; address: string }>();
      for (const row of rows) {
        const token = this.object(this.object(row).token);
        const id = this.string(token.id);
        const address = this.string(token.tokenAddress) ?? this.string(token.address);
        const symbol = this.string(token.symbol);
        if (!id || !address || !symbol || !isAddress(address)) continue;
        const normalized = getAddress(address).toLowerCase();
        const allowed = ARC_TOKENS[normalized];
        if (!allowed || allowed.symbol !== symbol.toUpperCase()) continue;
        metadata.set(id, { symbol: allowed.symbol, address: normalized });
      }
      return metadata;
    })().finally(() => this.tokenMetadataFlights.delete(key));
    this.tokenMetadataFlights.set(key, flight);
    return flight;
  }

  private async projectCirclePayroll(
    principal: AuthenticatedCirclePrincipal,
    transactions: unknown[],
  ) {
    const claimed = new Set<string>();
    if (!(await this.canonicalOwnerIsUnambiguous(principal))) return claimed;
    const byId = new Map(
      transactions.flatMap((value) => {
        const transaction = this.object(value);
        const id = this.string(transaction.id);
        return id ? [[id, transaction] as const] : [];
      }),
    );
    const tasks = await this.prisma.task.findMany({
      where: { type: 'payroll' },
      include: { transactions: true, units: true },
    });
    for (const task of tasks) {
      const owner = this.taskOwner(task.metadata, task.payload);
      if (
        !owner ||
        !this.sameWallet(owner, principal.merchantWalletAddress) ||
        task.transactions.length === 0
      )
        continue;
      const providerTransactions = task.transactions
        .map((row) => byId.get(row.txId))
        .filter((transaction): transaction is JsonObject => Boolean(transaction));
      if (
        providerTransactions.length === 0 ||
        providerTransactions.some(
          (transaction) =>
            transaction.operation !== 'TRANSFER' ||
            transaction.blockchain !== 'ARC-TESTNET' ||
            transaction.walletId !== principal.circleWalletId ||
            !this.sameWallet(
              this.string(transaction.sourceAddress) ?? '',
              principal.merchantWalletAddress,
            ),
        )
      )
        continue;
      await this.projectPayroll(principal, task);
      task.transactions
        .filter((row) => byId.has(row.txId))
        .forEach((row) => claimed.add(row.txId));
    }
    return claimed;
  }

  private circleTransactions(response: unknown): unknown[] {
    const root = this.object(response);
    const nested = this.object(root.data);
    return (
      Array.isArray(root.transactions)
        ? root.transactions
        : Array.isArray(nested.transactions)
          ? nested.transactions
          : []
    ) as unknown[];
  }

  private async projectCircleTransactions(
    principal: AuthenticatedCirclePrincipal,
    transactions: unknown[],
    excludedTransactionIds: Set<string>,
    tokenMetadata: Map<string, { symbol: string; address: string }>,
  ) {
    let accepted = 0;
    for (const value of transactions) {
      const tx = this.object(value);
      const id = this.string(tx.id);
      const walletId = this.string(tx.walletId);
      const source = this.string(tx.sourceAddress);
      const destination = this.string(tx.destinationAddress);
      if (id && excludedTransactionIds.has(id)) continue;
      if (
        !id ||
        walletId !== principal.circleWalletId ||
        tx.operation !== 'TRANSFER' ||
        tx.blockchain !== 'ARC-TESTNET'
      )
        continue;
      if (
        !source ||
        !destination ||
        !isAddress(source) ||
        !isAddress(destination)
      )
        continue;
      const outgoing = this.sameWallet(source, principal.merchantWalletAddress);
      const incoming = this.sameWallet(
        destination,
        principal.merchantWalletAddress,
      );
      if (outgoing === incoming) continue;
      const amounts = Array.isArray(tx.amounts) ? tx.amounts : [];
      if (amounts.length !== 1 || !this.string(String(amounts[0]))) continue;
      const state = (this.string(tx.state) ?? '').toUpperCase();
      const circleToken = this.circleToken(tx, tokenMetadata);
      await this.upsert({
        ownerUserId: principal.merchantUserId,
        walletAddress: principal.merchantWalletAddress,
        type: outgoing ? 'send' : 'receive',
        direction: outgoing ? 'outgoing' : 'incoming',
        status: this.circleStatus(state),
        source: 'circle_w3s',
        idempotencyKey: `circle-transaction:${id}`,
        sourceReferenceType: 'circle_transaction',
        sourceReferenceId: id,
        transactionId: id,
        chainId: tx.blockchain === 'ARC-TESTNET' ? 5042002 : undefined,
        txHash: this.isTxHash(tx.txHash) ? String(tx.txHash) : undefined,
        inputTokenSymbol: outgoing ? circleToken.symbol : undefined,
        inputTokenAddress: outgoing ? circleToken.address : undefined,
        inputAmount: outgoing ? String(amounts[0]) : undefined,
        outputTokenSymbol: incoming ? circleToken.symbol : undefined,
        outputTokenAddress: incoming ? circleToken.address : undefined,
        outputAmount: incoming ? String(amounts[0]) : undefined,
        counterparty: outgoing ? destination : source,
        metadata: this.string(tx.tokenId)
          ? { circleTokenId: this.string(tx.tokenId)! }
          : undefined,
        occurredAt: this.date(tx.createDate),
      });
      accepted += 1;
    }
    return accepted;
  }

  private circleToken(tx: JsonObject, metadata = new Map<string, { symbol: string; address: string }>()): { symbol?: string; address?: string } {
    const nested = this.object(tx.token);
    const address = this.string(tx.tokenAddress) ?? this.string(nested.address) ?? this.string(nested.tokenAddress);
    const configured = address && isAddress(address) ? ARC_TOKENS[getAddress(address).toLowerCase()] : undefined;
    const resolved = this.string(tx.tokenId) ? metadata.get(this.string(tx.tokenId)!) : undefined;
    const symbol = configured?.symbol ?? resolved?.symbol ?? this.string(tx.tokenSymbol) ?? this.string(nested.symbol);
    return { symbol, address: address && isAddress(address) ? getAddress(address).toLowerCase() : resolved?.address };
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

  private taskOwner(metadata: unknown, payload: unknown) {
    const meta = this.object(metadata);
    const body = this.object(payload);
    return (
      this.string(meta.walletAddress) ??
      this.string(meta.sourceAddress) ??
      this.string(body.walletAddress) ??
      this.string(body.sourceAddress)
    );
  }
  private taskStatus(value: string): ActivityStatus {
    if (value === 'executed') return 'completed';
    if (value === 'failed') return 'failed';
    if (value === 'partial') return 'recovery_required';
    if (value === 'created' || value === 'assigned') return 'pending';
    return 'confirming';
  }
  private xylonetStatus(
    stage: string,
    terminal: string | null,
  ): ActivityStatus {
    if (terminal === 'confirmed' || stage === 'completed') return 'completed';
    if (terminal === 'cancelled' || terminal === 'rejected') return 'cancelled';
    if (terminal === 'failed') return 'failed';
    if (stage.includes('submitted')) return 'submitted';
    if (stage.includes('confirm')) return 'confirming';
    return 'pending';
  }
  private circleStatus(state: string): ActivityStatus {
    if (
      ['COMPLETE', 'COMPLETED', 'CONFIRMED', 'SUCCESS', 'SUCCEEDED'].includes(
        state,
      )
    )
      return 'completed';
    if (['FAILED', 'DENIED', 'REJECTED'].includes(state)) return 'failed';
    if (state === 'EXPIRED') return 'expired';
    if (['CANCELLED', 'CANCELED'].includes(state)) return 'cancelled';
    if (['SUBMITTED', 'SENT', 'INITIATED', 'QUEUED'].includes(state))
      return 'submitted';
    return 'confirming';
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
  private string(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }
  private number(value: unknown) {
    return typeof value === 'number' && Number.isSafeInteger(value)
      ? value
      : undefined;
  }
  private date(value: unknown) {
    const text = this.string(value);
    if (!text) return undefined;
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  private isTxHash(value: unknown): value is string {
    return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
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
  private async canonicalOwnerIsUnambiguous(principal: ActivityOwnerPrincipal) {
    const wallets = await this.prisma.userWallet.findMany({
      where: { blockchain: 'ARC-TESTNET' },
      select: { userId: true, address: true },
    });
    const owners = new Set(
      wallets
        .filter((wallet) =>
          this.sameWallet(wallet.address, principal.merchantWalletAddress),
        )
        .map((wallet) => wallet.userId),
    );
    return owners.size === 1 && owners.has(principal.merchantUserId);
  }
  private safeMetadata(value?: Record<string, unknown>) {
    if (!value) return undefined;
    const allowed = [
      'invoicePublicId',
      'transactionCount',
      'sourceChainId',
      'destinationChainId',
      'circleTokenId',
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
