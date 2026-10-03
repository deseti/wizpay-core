import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { Prisma, type ReconciliationWork } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

export type RecoveryKind = 'INTENT' | 'SWAP' | 'BRIDGE' | 'ACTIVITY';
export const DELIVERY_LEASE_MS = 120_000;
export const MAX_DELIVERY_ATTEMPTS = 12;
export class RecoveryDeferred extends Error {
  constructor(readonly code = 'RECOVERY_DEFERRED') {
    super(code);
  }
}
export class RecoveryRejected extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

@Injectable()
export class PostgresDeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  assertNetwork() {
    if (
      this.config.getOrThrow('arcNetwork.key') !== 'arc-mainnet' ||
      this.config.getOrThrow('arcNetwork.chainId') !== 5042
    ) {
      throw new Error(
        'Reconciliation requires the selected Arc Mainnet runtime.',
      );
    }
  }

  async enqueue(kind: RecoveryKind, recordId: string, evidenceKey: string) {
    this.assertNetwork();
    if (
      !['INTENT', 'SWAP', 'BRIDGE', 'ACTIVITY'].includes(kind) ||
      !recordId ||
      recordId.length > 160 ||
      !evidenceKey ||
      evidenceKey.length > 512
    )
      throw new Error('Invalid recovery identity.');
    return this.prisma.reconciliationWork.upsert({
      where: { kind_recordId_evidenceKey: { kind, recordId, evidenceKey } },
      create: { kind, recordId, evidenceKey },
      update: {},
    });
  }

  async claim(): Promise<ReconciliationWork | null> {
    this.assertNetwork();
    const token = randomUUID();
    const rows = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
        return tx.$queryRaw<ReconciliationWork[]>(Prisma.sql`
      WITH candidate AS (
        SELECT "id" FROM "ReconciliationWork"
        WHERE "network" = 'arc-mainnet' AND "acknowledgedAt" IS NULL AND "failedAt" IS NULL
          AND "availableAt" <= clock_timestamp()
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= clock_timestamp())
        ORDER BY "availableAt", "createdAt", "id" FOR UPDATE SKIP LOCKED LIMIT 1
      )
      UPDATE "ReconciliationWork" w SET "leaseToken" = ${token}::uuid,
        "leaseExpiresAt" = clock_timestamp() + ${DELIVERY_LEASE_MS} * interval '1 millisecond',
        "attempts" = "attempts" + 1, "updatedAt" = clock_timestamp()
      FROM candidate WHERE w."id" = candidate."id" RETURNING w.*`);
      },
      { timeout: 2_500, maxWait: 1_000 },
    );
    return rows[0] ?? null;
  }

  async commit(
    work: ReconciliationWork,
    apply: (tx: Prisma.TransactionClient) => Promise<void>,
    failureCode?: string,
  ) {
    this.assertNetwork();
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`;
        const owned = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id" FROM "ReconciliationWork" WHERE "id" = ${work.id}::uuid
          AND "leaseToken" = ${work.leaseToken}::uuid AND "leaseExpiresAt" > clock_timestamp()
          AND "acknowledgedAt" IS NULL AND "failedAt" IS NULL FOR UPDATE`);
        if (owned.length !== 1)
          throw new RecoveryDeferred('RECOVERY_LEASE_LOST');
        await apply(tx);
        await tx.reconciliationWork.update({
          where: { id: work.id },
          data: {
            ...(failureCode
              ? { failedAt: new Date(), failureCode }
              : { acknowledgedAt: new Date(), failureCode: null }),
            leaseToken: null,
            leaseExpiresAt: null,
          },
        });
      },
      { timeout: 5_000, maxWait: 1_000 },
    );
  }

  async retry(work: ReconciliationWork, code: string, permanent = false) {
    const now = new Date();
    const exhausted = work.attempts >= MAX_DELIVERY_ATTEMPTS;
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '2000ms'`;
        return tx.reconciliationWork.updateMany({
          where: {
            id: work.id,
            leaseToken: work.leaseToken,
            leaseExpiresAt: { gt: now },
            acknowledgedAt: null,
            failedAt: null,
          },
          data: {
            leaseToken: null,
            leaseExpiresAt: null,
            failureCode: /^[A-Z0-9_]{1,80}$/.test(code)
              ? code
              : 'RECOVERY_ERROR',
            ...(permanent || exhausted
              ? { failedAt: now }
              : {
                  availableAt: new Date(
                    now.getTime() +
                      Math.min(
                        30_000 * 2 ** Math.min(work.attempts - 1, 7),
                        3_600_000,
                      ),
                  ),
                }),
          },
        });
      },
      { timeout: 2_500, maxWait: 1_000 },
    );
  }
}
