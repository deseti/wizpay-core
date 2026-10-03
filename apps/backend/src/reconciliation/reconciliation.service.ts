import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  PostgresDeliveryService,
  RecoveryDeferred,
  RecoveryRejected,
} from './postgres-delivery.service';
import { RecoveryVerifierService, object } from './recovery-verifier.service';

export interface ReconciliationOptions {
  limit?: number;
  budgetMs?: number;
}
export interface ReconciliationSummary {
  discovered: number;
  claimed: number;
  acknowledged: number;
  retried: number;
  rejected: number;
  timedOut: number;
}

@Injectable()
export class ReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly delivery: PostgresDeliveryService,
    private readonly verifier: RecoveryVerifierService,
  ) {}

  async runReconciliationBatch(
    options: ReconciliationOptions = {},
  ): Promise<ReconciliationSummary> {
    this.delivery.assertNetwork();
    const limit = options.limit ?? 5;
    const budgetMs = options.budgetMs ?? 20_000;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10 ||
      !Number.isInteger(budgetMs) ||
      budgetMs < 1_000 ||
      budgetMs > 25_000
    )
      throw new Error('Invalid bounded reconciliation options.');
    const deadline = Date.now() + budgetMs;
    const summary: ReconciliationSummary = {
      discovered: 0,
      claimed: 0,
      acknowledged: 0,
      retried: 0,
      rejected: 0,
      timedOut: 0,
    };
    // Existing durable rows are an outbox: interrupted HTTP calls need no atomic
    // dual write to discover their already-persisted evidence on the next batch.
    summary.discovered = await this.discover(limit);
    for (
      let index = 0;
      index < limit && Date.now() + 5_000 < deadline;
      index++
    ) {
      const work = await this.delivery.claim();
      if (!work) break;
      summary.claimed++;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const remaining = Math.min(10_000, deadline - Date.now() - 5_000);
        const apply = await Promise.race([
          this.verifier.prepare(work),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new RecoveryDeferred('RECOVERY_TIME_BUDGET')),
              remaining,
            );
          }),
        ]);
        if (Date.now() + 5_000 >= deadline)
          throw new RecoveryDeferred('RECOVERY_TIME_BUDGET');
        await this.delivery.commit(work, apply);
        summary.acknowledged++;
      } catch (error) {
        const outcome = recoveryFailure(error);
        if (outcome.code === 'RECOVERY_TIME_BUDGET') summary.timedOut++;
        if (outcome.permanent) {
          // Terminal verification failures are recorded without touching signing,
          // immutable identities, or already-terminal intent state.
          try {
            await this.delivery.commit(
              work,
              async (tx) => {
                if (work.kind !== 'INTENT' || !outcome.verificationMismatch)
                  return;
                await tx.executionIntent.updateMany({
                  where: {
                    id: work.recordId,
                    leaseOwner: work.leaseToken,
                    status: {
                      in: ['SUBMITTED', 'VERIFYING', 'FAILED_RETRYABLE'],
                    },
                    transactionHash: work.evidenceKey,
                  },
                  data: { status: 'FAILED_FINAL', failureCode: outcome.code },
                });
              },
              outcome.code,
            );
            summary.rejected++;
          } catch {
            // A stale observer cannot apply a terminal result after losing its fence.
            await this.delivery.retry(work, 'RECOVERY_COMMIT_RETRY');
            summary.retried++;
          }
        } else {
          summary.retried++;
          await this.delivery.retry(work, outcome.code);
        }
      } finally {
        if (timer) clearTimeout(timer);
        if (work.kind === 'INTENT')
          await this.prisma
            .$transaction(
              async (tx) => {
                await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
                return tx.executionIntent.updateMany({
                  where: { id: work.recordId, leaseOwner: work.leaseToken },
                  data: { leaseOwner: null, leaseExpiresAt: null },
                });
              },
              { timeout: 2_500, maxWait: 1_000 },
            )
            .catch(() => undefined);
      }
    }
    return summary;
  }

  private async discover(limit: number) {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
        const candidates = await tx.$queryRaw<
          {
            kind: 'INTENT' | 'BRIDGE' | 'ACTIVITY';
            recordId: string;
            evidenceKey: string;
          }[]
        >(Prisma.sql`
      WITH intents AS (
        SELECT 'INTENT' AS kind, i."id"::text AS "recordId", lower(i."transactionHash") AS "evidenceKey"
        FROM "ExecutionIntent" i WHERE i."network" = 'arc-mainnet'
          AND i."operation" IN ('SEND', 'PAYROLL', 'INVOICE_SETTLEMENT', 'PAYMENT_LINK_SETTLEMENT')
          AND i."transactionHash" ~ '^0x[0-9a-fA-F]{64}$'
          AND (i."status" IN ('SUBMITTED', 'VERIFYING', 'FAILED_RETRYABLE') OR
            (i."status" = 'COMPLETED' AND (
              (i."operation" = 'PAYROLL' AND EXISTS (SELECT 1 FROM "TaskUnit" u WHERE u."taskId" = i."taskId" AND u."status" = 'PENDING' AND u."payload"->>'executionIntentId' = i."id"::text)) OR
              (i."operation" IN ('INVOICE_SETTLEMENT', 'PAYMENT_LINK_SETTLEMENT') AND EXISTS (SELECT 1 FROM "Invoice" v WHERE v."publicId" = i."externalReference" AND v."status" IN ('OPEN', 'VERIFYING'))))))
          AND NOT EXISTS (SELECT 1 FROM "ReconciliationWork" w WHERE w."kind" = 'INTENT' AND w."recordId" = i."id"::text AND w."evidenceKey" = lower(i."transactionHash"))
        ORDER BY i."updatedAt", i."id" LIMIT ${limit}
      ), bridges AS (
        SELECT 'BRIDGE' AS kind, b."id" AS "recordId",
          lower(b."result"->>'sourceTransactionHash') || ':' || COALESCE(lower(b."result"->>'destinationTransactionHash'), '') AS "evidenceKey"
        FROM "BridgeTransaction" b WHERE b."status" NOT IN ('completed', 'source_rejected', 'source_failed_before_burn', 'configuration_error')
          AND (b."payload"->>'sourceChainId' = '5042' OR b."payload"->>'destinationChainId' = '5042')
          AND b."result"->>'sourceTransactionHash' ~ '^0x[0-9a-fA-F]{64}$'
          AND NOT EXISTS (SELECT 1 FROM "ReconciliationWork" w WHERE w."kind" = 'BRIDGE' AND w."recordId" = b."id" AND w."evidenceKey" = lower(b."result"->>'sourceTransactionHash') || ':' || COALESCE(lower(b."result"->>'destinationTransactionHash'), ''))
        ORDER BY b."updatedAt", b."id" LIMIT ${limit}
      ), activities AS (
        SELECT 'ACTIVITY' AS kind, a."id"::text AS "recordId",
          COALESCE((extract(epoch FROM a."lastCompletedAt") * 1000)::bigint::text, 'initial') || ':' || COALESCE(a."checkpointTransactionId", '') AS "evidenceKey"
        FROM "ActivitySyncState" a WHERE a."source" = 'external_wallet'
          AND (a."nextAllowedAt" IS NULL OR a."nextAllowedAt" <= clock_timestamp())
          AND (a."leaseExpiresAt" IS NULL OR a."leaseExpiresAt" <= clock_timestamp())
          AND EXISTS (SELECT 1 FROM "UserWallet" u WHERE u."userId" = a."ownerUserId" AND lower(u."address") = lower(a."walletAddress") AND u."blockchain" = 'ARC-MAINNET' AND u."chain" = 'EVM')
          AND NOT EXISTS (SELECT 1 FROM "ReconciliationWork" w WHERE w."kind" = 'ACTIVITY' AND w."recordId" = a."id"::text AND w."evidenceKey" = COALESCE((extract(epoch FROM a."lastCompletedAt") * 1000)::bigint::text, 'initial') || ':' || COALESCE(a."checkpointTransactionId", ''))
        ORDER BY a."updatedAt", a."id" LIMIT ${limit}
      ) SELECT * FROM intents UNION ALL SELECT * FROM bridges UNION ALL SELECT * FROM activities`);
        await tx.reconciliationWork.createMany({
          data: candidates,
          skipDuplicates: true,
        });
        return candidates.length;
      },
      { timeout: 2_500, maxWait: 1_000 },
    );
  }
}

export function recoveryFailure(error: unknown) {
  if (error instanceof RecoveryRejected)
    return { code: error.code, permanent: true, verificationMismatch: false };
  if (error instanceof RecoveryDeferred)
    return { code: error.code, permanent: false, verificationMismatch: false };
  const response =
    error &&
    typeof error === 'object' &&
    'getResponse' in error &&
    typeof error.getResponse === 'function'
      ? object((error.getResponse as () => unknown).call(error))
      : object(error);
  const code =
    typeof response.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(response.code)
      ? response.code
      : 'RECOVERY_TRANSIENT_ERROR';
  const mismatch = [
    'EXECUTION_INTENT_RECEIPT_MISMATCH',
    'PAYROLL_RECEIPT_MISMATCH',
    'SWAP_RECEIPT_MISMATCH',
    'BRIDGE_ATTESTATION_MISMATCH',
    'BRIDGE_DESTINATION_MISMATCH',
  ].includes(code);
  return {
    code,
    permanent: response.retryable === false || mismatch,
    verificationMismatch: mismatch,
  };
}
