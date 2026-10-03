import { ConfigService } from '@nestjs/config';
import { ConflictException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { openPostgresHarness } from '../../test/postgres-harness';
import { PrismaService } from '../database/prisma.service';
import { ExecutionIntentService } from '../execution-intent/execution-intent.service';
import { DirectTransferReceiptVerifierService } from '../execution-intent/direct-transfer-receipt-verifier.service';
import { PayrollReceiptVerifierService } from '../task/payroll-receipt-verifier.service';
import { InvoicePaymentVerifierService } from '../invoice/invoice-payment-verifier.service';
import { MainnetUniswapV4Service } from '../user-swap/mainnet-uniswap-v4.service';
import { BridgeLifecycleService } from '../bridge/bridge-lifecycle.service';
import { TaskUnitService } from '../task/task-unit.service';
import { TaskMapperService } from '../task/task-mapper.service';
import { TaskTransactionService } from '../task/task-transaction.service';
import { PaymentRoutingService } from '../routing/payment-routing.service';
import { ActivityService } from '../activity/activity.service';
import {
  PostgresDeliveryService,
  RecoveryDeferred,
} from './postgres-delivery.service';
import { RecoveryVerifierService } from './recovery-verifier.service';
import { ReconciliationService } from './reconciliation.service';

// Never accidentally borrow the hosted Phase 2 database target.
const describeLocal = process.env.PHASE5_TEST_DATABASE_URL
  ? describe
  : describe.skip;
const wallet = '0x1000000000000000000000000000000000000001';
const recipient = '0x2000000000000000000000000000000000000002';
const token = '0x3000000000000000000000000000000000000003';
const hash = (number: number) => `0x${number.toString(16).padStart(64, '0')}`;
const routing = {
  network: 'arc-mainnet',
  chainId: 5042,
  decide: () => ({
    kind: 'DIRECT_TRANSFER',
    provider: null,
    tokenIn: token,
    tokenOut: token,
  }),
  assertExecutable: (value: unknown) => value,
} as unknown as PaymentRoutingService;

describeLocal('Phase 5 local PostgreSQL durability', () => {
  let harness: Awaited<ReturnType<typeof openPostgresHarness>>;
  let prisma: PrismaClient;
  let delivery: PostgresDeliveryService;
  let verifier: RecoveryVerifierService;
  let batch: ReconciliationService;
  let intents: ExecutionIntentService;
  let units: TaskUnitService;
  const direct = { verify: jest.fn() };
  const payroll = { verify: jest.fn() };
  const invoiceVerifier = { verify: jest.fn() };
  const swaps = { confirmTransaction: jest.fn() };
  const bridges = { observeRecovery: jest.fn() };

  beforeAll(async () => {
    harness = await openPostgresHarness(
      'PHASE5_TEST_DATABASE_URL',
      'wizpay_phase5_test_admin',
    );
    prisma = harness.prisma;
    const database = prisma as unknown as PrismaService;
    delivery = new PostgresDeliveryService(
      database,
      new ConfigService({ arcNetwork: { key: 'arc-mainnet', chainId: 5042 } }),
    );
    units = new TaskUnitService(
      database,
      new TaskMapperService(database, new TaskTransactionService(database)),
    );
    verifier = new RecoveryVerifierService(
      database,
      direct as unknown as DirectTransferReceiptVerifierService,
      payroll as unknown as PayrollReceiptVerifierService,
      invoiceVerifier as unknown as InvoicePaymentVerifierService,
      swaps as unknown as MainnetUniswapV4Service,
      bridges as unknown as BridgeLifecycleService,
      units,
      routing,
    );
    batch = new ReconciliationService(database, delivery, verifier);
    intents = new ExecutionIntentService(database, routing);
  });
  afterAll(async () => {
    await harness?.close();
  });
  beforeEach(async () => {
    jest.resetAllMocks();
    await prisma.reconciliationWork.deleteMany();
    await prisma.activitySyncState.deleteMany();
    await prisma.activity.deleteMany();
    await prisma.userWallet.deleteMany();
    await prisma.executionIntent.deleteMany();
    await prisma.task.deleteMany();
    await prisma.bridgeTransaction.deleteMany();
    await prisma.invoice.deleteMany();
    await prisma.verifiedSwapTransaction.deleteMany();
    direct.verify.mockImplementation(
      (input: {
        transactionHash: string;
        sender: string;
        recipient: string;
        token: string;
        amountUnits: string;
      }) =>
        Promise.resolve({
          network: 'arc-mainnet',
          transactionHash: input.transactionHash,
          sourceWallet: input.sender,
          recipient: input.recipient,
          token: input.token,
          amountUnits: input.amountUnits,
        }),
    );
  });

  async function submitted(number: number) {
    const intent = await intents.acquire({
      network: 'arc-mainnet',
      operation: 'SEND',
      sourceWallet: wallet,
      recipient,
      tokenIn: token,
      tokenOut: token,
      amountUnits: '1',
      externalReference: `send-${number}`,
    });
    return intents.bindKnownTransactionHash(
      intent.id,
      intent.idempotencyKey,
      hash(number),
    );
  }

  it('verifies persisted known hashes once, commits before acknowledgment, and safely repeats', async () => {
    const intent = await submitted(1);
    const result = await batch.runReconciliationBatch();
    expect(result).toMatchObject({ claimed: 1, acknowledged: 1, retried: 0 });
    expect(await intents.get(intent.id)).toMatchObject({
      status: 'COMPLETED',
      leaseOwner: null,
    });
    expect(
      (await prisma.reconciliationWork.findFirst())?.acknowledgedAt,
    ).toBeInstanceOf(Date);
    expect(await batch.runReconciliationBatch()).toMatchObject({ claimed: 0 });
    await delivery.enqueue('INTENT', intent.id, hash(1));
    expect(await prisma.reconciliationWork.count()).toBe(1);
    expect(direct.verify).toHaveBeenCalledTimes(1);
  });

  it('never discovers missing hashes and fails closed on fabricated delivery evidence', async () => {
    const intent = await intents.acquire({
      network: 'arc-mainnet',
      operation: 'SEND',
      sourceWallet: wallet,
      recipient,
      tokenIn: token,
      tokenOut: token,
      amountUnits: '1',
      externalReference: 'missing',
    });
    expect(await batch.runReconciliationBatch()).toMatchObject({ claimed: 0 });
    await delivery.enqueue('INTENT', intent.id, hash(2));
    expect(await batch.runReconciliationBatch()).toMatchObject({
      rejected: 1,
      acknowledged: 0,
    });
    expect((await intents.get(intent.id)).transactionHash).toBeNull();
    expect(direct.verify).not.toHaveBeenCalled();
  });

  it('atomically leases one delivery to only one of two concurrent invocations', async () => {
    await delivery.enqueue('INTENT', randomUUID(), hash(3));
    const claims = await Promise.all([delivery.claim(), delivery.claim()]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const winner = claims.find(Boolean)!;
    expect(winner.attempts).toBe(1);
    expect(winner.leaseExpiresAt!.getTime() - Date.now()).toBeLessThanOrEqual(
      120_000,
    );
  });

  it('recovers expired leases and rejects stale acknowledgment or terminal writes', async () => {
    const intent = await submitted(4);
    await delivery.enqueue('INTENT', intent.id, hash(4));
    const stale = (await delivery.claim())!;
    const apply = await verifier.prepare(stale);
    await prisma.reconciliationWork.update({
      where: { id: stale.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    const fresh = (await delivery.claim())!;
    expect(fresh.leaseToken).not.toBe(stale.leaseToken);
    await expect(delivery.commit(stale, apply)).rejects.toBeInstanceOf(
      RecoveryDeferred,
    );
    await expect(
      delivery.commit(
        stale,
        async (tx) => {
          await tx.executionIntent.update({
            where: { id: intent.id },
            data: { status: 'FAILED_FINAL' },
          });
        },
        'MISMATCH',
      ),
    ).rejects.toBeInstanceOf(RecoveryDeferred);
    expect((await intents.get(intent.id)).status).toBe('SUBMITTED');
    await prisma.executionIntent.update({
      where: { id: intent.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await delivery.commit(fresh, await verifier.prepare(fresh));
    expect((await intents.get(intent.id)).status).toBe('COMPLETED');
  });

  it('rolls back partial processing and never acknowledges before durable success', async () => {
    const intent = await submitted(5);
    await delivery.enqueue('INTENT', intent.id, hash(5));
    const work = (await delivery.claim())!;
    await expect(
      delivery.commit(work, async (tx) => {
        await tx.executionIntent.update({
          where: { id: intent.id },
          data: { status: 'COMPLETED' },
        });
        throw new Error('test interruption');
      }),
    ).rejects.toThrow('test interruption');
    expect((await intents.get(intent.id)).status).toBe('SUBMITTED');
    expect(
      (
        await prisma.reconciliationWork.findUniqueOrThrow({
          where: { id: work.id },
        })
      ).acknowledgedAt,
    ).toBeNull();
  });

  it('keeps transient failure retryable with bounded backoff and records exhaustion', async () => {
    const intent = await submitted(6);
    direct.verify.mockRejectedValue(new Error('provider unavailable'));
    expect(await batch.runReconciliationBatch()).toMatchObject({ retried: 1 });
    let work = (await prisma.reconciliationWork.findFirst())!;
    expect(work).toMatchObject({
      attempts: 1,
      failedAt: null,
      acknowledgedAt: null,
      failureCode: 'RECOVERY_TRANSIENT_ERROR',
    });
    expect(work.availableAt.getTime() - Date.now()).toBeGreaterThan(25_000);
    expect(await batch.runReconciliationBatch()).toMatchObject({ claimed: 0 });
    await prisma.reconciliationWork.update({
      where: { id: work.id },
      data: { availableAt: new Date(0), attempts: 11 },
    });
    expect(await batch.runReconciliationBatch()).toMatchObject({ retried: 1 });
    work = (await prisma.reconciliationWork.findFirst())!;
    expect(work.attempts).toBe(12);
    expect(work.failedAt).toBeInstanceOf(Date);
    expect((await intents.get(intent.id)).status).toBe('SUBMITTED');
  });

  it('persists authoritative terminal mismatches without regressing terminal intents', async () => {
    const intent = await submitted(7);
    direct.verify.mockRejectedValue(
      new ConflictException({
        code: 'EXECUTION_INTENT_RECEIPT_MISMATCH',
        retryable: false,
      }),
    );
    expect(await batch.runReconciliationBatch()).toMatchObject({ rejected: 1 });
    expect((await intents.get(intent.id)).status).toBe('FAILED_FINAL');
    const rejected = await prisma.reconciliationWork.findFirst();
    expect(rejected?.failedAt).toBeInstanceOf(Date);
    expect(rejected?.acknowledgedAt).toBeNull();
    direct.verify.mockClear();
    await delivery.enqueue('INTENT', intent.id, hash(8));
    expect(await batch.runReconciliationBatch()).toMatchObject({
      acknowledged: 1,
    });
    expect((await intents.get(intent.id)).status).toBe('FAILED_FINAL');
    expect(direct.verify).not.toHaveBeenCalled();
  });

  it('bounds work and makes simultaneous batches idempotent', async () => {
    for (let index = 10; index < 15; index++) await submitted(index);
    const result = await batch.runReconciliationBatch({ limit: 2 });
    expect(result.claimed).toBe(2);
    const concurrent = await Promise.all([
      batch.runReconciliationBatch({ limit: 2 }),
      batch.runReconciliationBatch({ limit: 2 }),
    ]);
    expect(concurrent.reduce((sum, item) => sum + item.acknowledged, 0)).toBe(
      2,
    );
    expect(await batch.runReconciliationBatch({ limit: 2 })).toMatchObject({
      acknowledged: 1,
    });
    expect(
      await prisma.executionIntent.count({ where: { status: 'COMPLETED' } }),
    ).toBe(5);
    expect(direct.verify).toHaveBeenCalledTimes(5);
  });

  it('recovers an authenticated reported swap only through the existing receipt verifier', async () => {
    swaps.confirmTransaction.mockResolvedValue({
      transactionHash: hash(20),
      walletAddress: wallet,
      chainId: 5042,
      tokenIn: token,
      tokenOut: token,
      amountIn: '1',
      amountOut: '1',
    });
    await delivery.enqueue('SWAP', wallet, hash(20));
    expect(await batch.runReconciliationBatch()).toMatchObject({
      acknowledged: 1,
    });
    expect(swaps.confirmTransaction).toHaveBeenCalledWith(hash(20), wallet);
    expect(await prisma.verifiedSwapTransaction.count()).toBe(1);
    expect(await batch.runReconciliationBatch()).toMatchObject({ claimed: 0 });
  });

  it('recovers payroll receipt evidence and its pending unit in one durable transaction', async () => {
    const task = await prisma.task.create({
      data: {
        type: 'payroll',
        status: 'in_progress',
        totalUnits: 1,
        payload: {},
      },
    });
    const digest = hash(25);
    const intent = await intents.acquire({
      network: 'arc-mainnet',
      operation: 'PAYROLL',
      sourceWallet: wallet,
      tokenIn: token,
      tokenOut: token,
      amountUnits: '1',
      externalReference: 'batch-ref',
      batchDigest: digest,
    });
    await intents.attachTask(intent.id, task.id);
    await intents.bindKnownTransactionHash(
      intent.id,
      intent.idempotencyKey,
      hash(26),
    );
    await prisma.taskUnit.create({
      data: {
        taskId: task.id,
        type: 'payroll',
        index: 0,
        payload: {
          executionIntentId: intent.id,
          referenceId: 'batch-ref',
          recipients: [{ address: recipient, amountUnits: '1' }],
        },
      },
    });
    payroll.verify.mockResolvedValue({
      network: 'arc-mainnet',
      transactionHash: hash(26),
      sourceWallet: wallet,
      token,
      amountUnits: '1',
      batchDigest: digest,
    });
    expect(await batch.runReconciliationBatch()).toMatchObject({
      acknowledged: 1,
    });
    expect(payroll.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedBatchDigest: digest,
        referenceId: 'batch-ref',
        recipients: [{ address: recipient, amountUnits: '1' }],
      }),
    );
    expect(
      await prisma.task.findUniqueOrThrow({ where: { id: task.id } }),
    ).toMatchObject({ completedUnits: 1, status: 'executed' });
    expect((await intents.get(intent.id)).status).toBe('COMPLETED');
    expect(await batch.runReconciliationBatch()).toMatchObject({ claimed: 0 });
  });

  it('recovers a verified invoice without bypassing receipt or payer/intent checks', async () => {
    const invoice = await prisma.invoice.create({
      data: {
        publicId: 'public-invoice',
        merchantUserId: 'merchant',
        merchantWalletAddress: recipient,
        chainId: 5042,
        tokenAddress: token,
        tokenSymbol: 'USDC',
        tokenDecimals: 6,
        amountUnits: '1',
        title: 'test',
      },
    });
    const intent = await intents.acquire({
      network: 'arc-mainnet',
      operation: 'INVOICE_SETTLEMENT',
      sourceWallet: wallet,
      recipient,
      tokenIn: token,
      tokenOut: token,
      amountUnits: '1',
      externalReference: invoice.publicId,
    });
    await intents.bindKnownTransactionHash(
      intent.id,
      intent.idempotencyKey,
      hash(27),
    );
    invoiceVerifier.verify.mockResolvedValue({
      transactionHash: hash(27),
      payerAddress: wallet,
    });
    expect(await batch.runReconciliationBatch()).toMatchObject({
      acknowledged: 1,
    });
    expect(invoiceVerifier.verify).toHaveBeenCalledWith({
      transactionHash: hash(27),
      tokenAddress: token,
      merchantWalletAddress: recipient,
      amountUnits: '1',
    });
    expect(
      await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }),
    ).toMatchObject({ status: 'PAID' });
    expect(
      await prisma.invoicePayment.findUniqueOrThrow({
        where: { invoiceId: invoice.id },
      }),
    ).toMatchObject({
      status: 'VERIFIED',
      transactionHash: hash(27),
      payerAddress: wallet,
    });
    expect((await intents.get(intent.id)).status).toBe('COMPLETED');
    // Model an interrupted client verification where the invoice was already
    // settled, but its existing intent has not yet consumed that evidence.
    const paidAt = (
      await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })
    ).paidAt;
    await prisma.reconciliationWork.deleteMany();
    await prisma.executionIntent.update({
      where: { id: intent.id },
      data: { status: 'SUBMITTED', completedAt: null },
    });
    expect(await batch.runReconciliationBatch()).toMatchObject({
      acknowledged: 1,
    });
    expect((await intents.get(intent.id)).status).toBe('COMPLETED');
    expect(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
        .paidAt,
    ).toEqual(paidAt);
    expect(await prisma.invoicePayment.count()).toBe(1);
  });

  it('fences bridge observations against changed durable evidence', async () => {
    const row = await prisma.bridgeTransaction.create({
      data: {
        taskId: randomUUID(),
        status: 'source_confirmed',
        payload: { sourceChainId: 5042 },
        result: { sourceTransactionHash: hash(28) },
      },
    });
    await delivery.enqueue('BRIDGE', row.id, `${hash(28)}:`);
    const work = (await delivery.claim())!;
    bridges.observeRecovery.mockResolvedValue({
      row,
      status: 'attestation_ready',
      result: { sourceTransactionHash: hash(28), attestation: '0x12' },
      messageHash: hash(29),
      nonce: 'nonce',
    });
    const apply = await verifier.prepare(work);
    await prisma.bridgeTransaction.update({
      where: { id: row.id },
      data: { status: 'completed' },
    });
    await expect(delivery.commit(work, apply)).rejects.toBeInstanceOf(
      RecoveryDeferred,
    );
    expect(
      (
        await prisma.bridgeTransaction.findUniqueOrThrow({
          where: { id: row.id },
        })
      ).status,
    ).toBe('completed');
    expect(
      (
        await prisma.reconciliationWork.findUniqueOrThrow({
          where: { id: work.id },
        })
      ).acknowledgedAt,
    ).toBeNull();
  });

  it('rejects invalid runtime configuration and invalid batch bounds', async () => {
    const invalid = new PostgresDeliveryService(
      prisma as unknown as PrismaService,
      new ConfigService({ arcNetwork: { key: 'arc-testnet', chainId: 5042 } }),
    );
    expect(() => invalid.assertNetwork()).toThrow();
    await expect(batch.runReconciliationBatch({ limit: 11 })).rejects.toThrow(
      'Invalid bounded',
    );
    await expect(
      batch.runReconciliationBatch({ budgetMs: 30_000 }),
    ).rejects.toThrow('Invalid bounded');
  });

  it('serializes duplicate HTTP/background payroll unit reports on the parent row', async () => {
    const task = await prisma.task.create({
      data: {
        type: 'payroll',
        status: 'in_progress',
        totalUnits: 1,
        payload: {},
      },
    });
    const unit = await prisma.taskUnit.create({
      data: { taskId: task.id, type: 'payroll', index: 0, payload: {} },
    });
    await Promise.all([
      units.reportUnit(task.id, unit.id, {
        status: 'SUCCESS',
        txHash: hash(21),
      }),
      units.reportUnit(task.id, unit.id, {
        status: 'SUCCESS',
        txHash: hash(21),
      }),
    ]);
    expect(
      await prisma.task.findUniqueOrThrow({ where: { id: task.id } }),
    ).toMatchObject({ completedUnits: 1, failedUnits: 0, status: 'executed' });
    expect(await prisma.taskLog.count()).toBe(1);
  });

  it('reuses activity ownership, lease, bounded cursor, and idempotent projections', async () => {
    await prisma.userWallet.create({
      data: {
        userId: 'owner',
        chain: 'EVM',
        blockchain: 'ARC-MAINNET',
        walletId: 'registered',
        address: wallet,
      },
    });
    const intent = await submitted(30);
    await batch.runReconciliationBatch();
    const state = await prisma.activitySyncState.create({
      data: {
        ownerUserId: 'owner',
        walletAddress: wallet,
        source: 'external_wallet',
      },
    });
    const activity = new ActivityService(prisma as unknown as PrismaService);
    const outcomes = await Promise.all([
      activity.reconcileExistingState(state.id),
      activity.reconcileExistingState(state.id),
    ]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    await prisma.activitySyncState.update({
      where: { id: state.id },
      data: { nextAllowedAt: new Date(0) },
    });
    await activity.reconcileExistingState(state.id);
    expect(
      await prisma.activity.count({
        where: { idempotencyKey: `execution-intent:${intent.id}` },
      }),
    ).toBe(1);
    await prisma.activitySyncState.update({
      where: { id: state.id },
      data: {
        nextAllowedAt: new Date(0),
        checkpointTransactionId: 'recovery-v1:0:',
        leaseExpiresAt: new Date(Date.now() - 1),
      },
    });
    await activity.reconcileExistingState(state.id);
    await prisma.activitySyncState.update({
      where: { id: state.id },
      data: { nextAllowedAt: new Date(0) },
    });
    await activity.reconcileExistingState(state.id);
    expect(await prisma.activity.count()).toBe(1);
    const unrelated = await prisma.activitySyncState.create({
      data: {
        ownerUserId: 'other',
        walletAddress: wallet,
        source: 'external_wallet',
      },
    });
    await expect(activity.reconcileExistingState(unrelated.id)).rejects.toThrow(
      'ownership conflict',
    );
  });
});
