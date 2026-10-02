import { PrismaClient } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import type { Hex } from 'viem';
import {
  getArcOperationResourceReadiness,
  resolveArcCapabilities,
} from '@wizpay/arc-network';
import { ActivityService } from '../activity/activity.service';
import {
  createPayrollBatchDigest,
  ExecutionIntentService,
} from '../execution-intent/execution-intent.service';
import { InvoiceService } from '../invoice/invoice.service';
import { PaymentRoutingService } from '../routing/payment-routing.service';

/* eslint-disable @typescript-eslint/no-unsafe-assignment */

import {
  hasPostgresTarget,
  openPostgresHarness,
} from '../../test/postgres-harness';

const describePostgres = hasPostgresTarget('PHASE7_TEST_DATABASE_URL')
  ? describe
  : describe.skip;

// These addresses exist only inside the offline rehearsal. They are deliberately
// absent from the Arc registry and must never be treated as Mainnet resources.
const OFFLINE_USDC = '0x3000000000000000000000000000000000000003';
const OFFLINE_EURC = '0x4000000000000000000000000000000000000004';
const APP_WALLET = '0x1000000000000000000000000000000000000001';
const EXTERNAL_WALLET = '0x1000000000000000000000000000000000000002';
const MERCHANT = '0x2000000000000000000000000000000000000001';
const RECIPIENT_A = '0x2000000000000000000000000000000000000002';
const RECIPIENT_B = '0x2000000000000000000000000000000000000003';
const hashes = Array.from(
  { length: 8 },
  (_, index): Hex => `0x${(index + 1).toString(16).repeat(64)}`,
);

describePostgres('Phase 7 deterministic offline Mainnet rehearsal', () => {
  let harness: Awaited<ReturnType<typeof openPostgresHarness>>;
  let secondaryHarness: Awaited<ReturnType<typeof openPostgresHarness>>;
  let prisma: PrismaClient;
  let secondaryPrisma: PrismaClient;
  let routing: PaymentRoutingService;
  let intents: ExecutionIntentService;
  let receiptVerifier: { verify: jest.Mock };
  let invoices: InvoiceService;

  beforeAll(async () => {
    harness = await openPostgresHarness(
      'PHASE7_TEST_DATABASE_URL',
      'wizpay_phase7_test_admin',
    );
    secondaryHarness = await openPostgresHarness(
      'PHASE7_TEST_DATABASE_URL',
      'wizpay_phase7_test_admin',
    );
    prisma = harness.prisma;
    secondaryPrisma = secondaryHarness.prisma;
  });

  beforeEach(async () => {
    await prisma.activity.deleteMany();
    await prisma.invoicePayment.deleteMany();
    await prisma.executionIntent.deleteMany();
    await prisma.invoice.deleteMany();
    routing = createRouting('arc-mainnet');
    intents = new ExecutionIntentService(prisma as never, routing);
    receiptVerifier = {
      verify: jest.fn(({ transactionHash }) => ({
        payerAddress: EXTERNAL_WALLET,
        transactionHash,
        confirmations: 2,
        blockNumber: 100n,
      })),
    };
    invoices = new InvoiceService(
      prisma as never,
      receiptVerifier as never,
      { assert: jest.fn() } as never,
      routing,
      intents,
    );
  });

  afterAll(async () => {
    await harness?.close();
    await secondaryHarness?.close();
  });

  it('rehearses every allowed direct-USDC lifecycle and one reconciled activity ledger', async () => {
    const circle = { createChallenge: jest.fn(() => 'challenge-1') };
    const appSend = await intents.acquire(
      sendInput('SEND-app-wallet', APP_WALLET, RECIPIENT_A),
    );
    const [appSendDuplicate] = await Promise.all([
      intents.acquire(sendInput('SEND-app-wallet', APP_WALLET, RECIPIENT_A)),
      intents.acquire(sendInput('SEND-app-wallet', APP_WALLET, RECIPIENT_A)),
    ]);
    expect(appSendDuplicate.id).toBe(appSend.id);
    await intents.acquireLease(appSend.id, 'offline-circle', 5_000);
    await intents.transition(appSend.id, 'CREATED', 'AUTHORIZATION_PENDING');
    await intents.bindCircleCorrelation(appSend.id, {
      challengeId: circle.createChallenge(),
      transactionId: 'circle-transaction-1',
    });
    await intents.bindTransactionHash(appSend.id, hashes[0]);
    await completeDirect(
      intents,
      appSend.id,
      hashes[0],
      APP_WALLET,
      RECIPIENT_A,
    );
    expect(circle.createChallenge).toHaveBeenCalledTimes(1);

    const externalSend = await intents.acquire(
      sendInput('SEND-external-wallet', EXTERNAL_WALLET, RECIPIENT_B),
    );
    await intents.prepareWalletSignature(
      externalSend.id,
      externalSend.idempotencyKey,
      'offline-browser',
      5_000,
    );
    await intents.bindTransactionHash(
      externalSend.id,
      hashes[1],
      'offline-browser',
    );
    await completeDirect(
      intents,
      externalSend.id,
      hashes[1],
      EXTERNAL_WALLET,
      RECIPIENT_B,
    );

    const payrollRecipients = [
      { recipient: RECIPIENT_A, token: OFFLINE_USDC, amountUnits: '1000000' },
      { recipient: RECIPIENT_B, token: OFFLINE_USDC, amountUnits: '2000000' },
    ];
    const payroll = await intents.acquire({
      network: 'arc-mainnet',
      operation: 'PAYROLL',
      sourceWallet: EXTERNAL_WALLET,
      batchDigest: createPayrollBatchDigest(payrollRecipients),
      tokenIn: OFFLINE_USDC,
      tokenOut: OFFLINE_USDC,
      amountUnits: '3000000',
      externalReference: 'PAYROLL-two-recipients',
    });
    await intents.bindTransactionHash(payroll.id, hashes[2]);
    await intents.beginVerification(payroll.id);
    await intents.completeWithVerifiedReceipt(payroll.id, {
      network: 'arc-mainnet',
      transactionHash: hashes[2],
      sourceWallet: EXTERNAL_WALLET,
      token: OFFLINE_USDC,
      amountUnits: '3000000',
      batchDigest: payroll.batchDigest!,
    });
    await expect(
      intents.acquire({
        network: 'arc-mainnet',
        operation: 'PAYROLL',
        sourceWallet: EXTERNAL_WALLET,
        batchDigest: createPayrollBatchDigest(payrollRecipients),
        tokenIn: OFFLINE_USDC,
        tokenOut: OFFLINE_USDC,
        amountUnits: '3000000',
        externalReference: 'PAYROLL-two-recipients',
      }),
    ).resolves.toMatchObject({ id: payroll.id, status: 'COMPLETED' });

    const invoice = await createAndPayRequest('INVOICE', hashes[3]);
    const paymentLink = await createAndPayRequest('PAYMENT_LINK', hashes[4]);
    expect(invoice.status).toBe('PAID');
    expect(paymentLink.status).toBe('PAID');

    const activity = new ActivityService(prisma as never);
    for (const [index, operation] of [
      ['send', appSend],
      ['send', externalSend],
      ['payroll', payroll],
    ] as const) {
      await activity.upsert({
        ownerUserId: 'offline-owner',
        walletAddress: operation.sourceWallet,
        type: index,
        direction: 'outgoing',
        status: 'completed',
        source: 'phase7_offline',
        idempotencyKey: `phase7:${operation.id}`,
        sourceReferenceType: 'execution_intent',
        sourceReferenceId: operation.id,
        chainId: 5_042,
        txHash: (await intents.get(operation.id)).transactionHash ?? undefined,
        inputTokenSymbol: 'USDC',
        inputTokenAddress: OFFLINE_USDC,
      });
    }
    for (const request of [invoice, paymentLink]) {
      await activity.upsert({
        ownerUserId: 'offline-owner',
        walletAddress: MERCHANT,
        type: 'invoice_payment',
        direction: 'incoming',
        status: 'completed',
        source: 'phase7_offline',
        idempotencyKey: `phase7:${request.publicId}`,
        sourceReferenceType: 'invoice',
        sourceReferenceId: request.publicId,
        chainId: 5_042,
        txHash: request.transactionHash ? request.transactionHash : undefined,
        outputTokenSymbol: 'USDC',
        outputTokenAddress: OFFLINE_USDC,
      });
    }
    const pages = await Promise.all(
      ([APP_WALLET, EXTERNAL_WALLET, MERCHANT] as Hex[]).map(
        (merchantWalletAddress) =>
          activity.list(
            {
              merchantUserId: 'offline-owner',
              merchantWalletAddress,
              merchantDisplayLabel: 'Offline Owner',
            },
            { limit: 20 },
          ),
      ),
    );
    const ledger = pages.flatMap((page) => page.items);
    expect(ledger).toHaveLength(5);
    expect(new Set(ledger.map((item) => item.txHash)).size).toBe(5);
    expect(
      pages
        .find((page) => page.items.some((item) => item.txHash === hashes[0]))
        ?.items.every((item) => item.txHash === hashes[0]),
    ).toBe(true);
  });

  it('recovers exact completion after a restart without a second settlement event', async () => {
    const intent = await intents.acquire(
      sendInput('SEND-restart', EXTERNAL_WALLET, RECIPIENT_A),
    );
    await intents.bindTransactionHash(intent.id, hashes[5]);
    await intents.beginVerification(intent.id);
    const receipt = directReceipt(hashes[5], EXTERNAL_WALLET, RECIPIENT_A);
    const completed = await intents.completeWithVerifiedReceipt(
      intent.id,
      receipt,
    );
    const restarted = new ExecutionIntentService(prisma as never, routing);
    await expect(
      restarted.completeWithVerifiedReceipt(intent.id, receipt),
    ).resolves.toMatchObject({ id: completed.id, status: 'COMPLETED' });
    await expect(
      restarted.completeWithVerifiedReceipt(intent.id, {
        ...receipt,
        recipient: RECIPIENT_B,
      }),
    ).rejects.toMatchObject({
      response: { code: 'EXECUTION_INTENT_RECEIPT_MISMATCH' },
    });
    expect(await prisma.executionIntent.count()).toBe(1);
  });

  it('keeps real unresolved Mainnet resources and every deferred route fail closed', () => {
    expect(getArcOperationResourceReadiness('arc-mainnet')).toEqual({
      sendDirect: true,
      payrollDirect: true,
      invoiceCreation: true,
      paymentLinkDirect: true,
      bridgeDirect: true,
      swapDirect: true,
      crossToken: true,
    });
    expect(
      resolveArcCapabilities('arc-mainnet', {
        WIZPAY_ARC_MAINNET_CAPABILITY_SEND: 'true',
      }).send,
    ).toBe(true);
    const capabilities = resolveArcCapabilities('arc-mainnet', {});
    expect(Object.values(capabilities).every((enabled) => !enabled)).toBe(true);
    expect(() =>
      routing.assertExecutable(
        routing.decide({
          network: 'arc-mainnet',
          operation: 'SEND',
          tokenIn: OFFLINE_USDC,
          tokenOut: OFFLINE_EURC,
        }),
      ),
    ).toThrow('Cross-token payments are unavailable');
    expect(() =>
      routing.decide({
        network: 'arc-mainnet',
        operation: 'SEND',
        tokenIn: '0x3600000000000000000000000000000000000000',
        tokenOut: '0x3600000000000000000000000000000000000000',
      }),
    ).toThrow('Payment token is not supported on the selected Arc network.');
  });

  it('keeps identical Mainnet references isolated in separate test namespaces', async () => {
    const mainnetRouting = createRouting('arc-mainnet');
    const secondaryIntents = new ExecutionIntentService(
      secondaryPrisma as never,
      mainnetRouting,
    );
    const reference = 'SEND-database-isolation';
    const mainnetIntent = await intents.acquire(
      sendInput(reference, EXTERNAL_WALLET, RECIPIENT_A),
    );
    const secondaryIntent = await secondaryIntents.acquire({
      ...sendInput(reference, EXTERNAL_WALLET, RECIPIENT_A),
      network: 'arc-mainnet',
    });
    // Logical identity is deterministic; persistence/state is independently isolated.
    expect(secondaryIntent.logicalKey).toBe(mainnetIntent.logicalKey);
    expect(secondaryIntent.id).not.toBe(mainnetIntent.id);
    await intents.cancelUnsubmitted(
      mainnetIntent.id,
      mainnetIntent.idempotencyKey,
    );
    expect((await secondaryIntents.get(secondaryIntent.id)).status).toBe(
      'CREATED',
    );
    expect(await prisma.executionIntent.count()).toBe(1);
    expect(await secondaryPrisma.executionIntent.count()).toBe(1);

    const activityInput = {
      ownerUserId: 'offline-owner',
      walletAddress: EXTERNAL_WALLET,
      type: 'send' as const,
      direction: 'outgoing' as const,
      status: 'completed' as const,
      source: 'phase7_offline',
      idempotencyKey: 'phase7:same-identifier',
      sourceReferenceType: 'execution_intent',
      sourceReferenceId: 'same-identifier',
    };
    const mainnetActivity = new ActivityService(prisma as never);
    const secondaryActivity = new ActivityService(secondaryPrisma as never);
    await mainnetActivity.upsert({ ...activityInput, chainId: 5_042 });
    await secondaryActivity.upsert({ ...activityInput, chainId: 5_042 });
    expect(await prisma.activity.count()).toBe(1);
    expect(await secondaryPrisma.activity.count()).toBe(1);
  });

  async function createAndPayRequest(
    settlementKind: 'INVOICE' | 'PAYMENT_LINK',
    transactionHash: Hex,
  ) {
    const request = await invoices.create(
      {
        merchantUserId: 'offline-owner',
        merchantWalletAddress: MERCHANT,
        merchantDisplayLabel: null,
      },
      {
        token: 'USDC',
        amount: '3',
        title: `${settlementKind} offline rehearsal`,
        settlementKind,
      },
    );
    const operation =
      settlementKind === 'PAYMENT_LINK'
        ? 'PAYMENT_LINK_SETTLEMENT'
        : 'INVOICE_SETTLEMENT';
    const intent = await intents.acquire({
      network: 'arc-mainnet',
      operation,
      sourceWallet: EXTERNAL_WALLET,
      recipient: MERCHANT,
      tokenIn: OFFLINE_USDC,
      tokenOut: OFFLINE_USDC,
      amountUnits: '3000000',
      externalReference: request.publicId,
    });
    await intents.bindTransactionHash(intent.id, transactionHash);
    const paid = await invoices.verifyPublicPayment(
      request.publicId,
      transactionHash,
    );
    await expect(
      invoices.verifyPublicPayment(request.publicId, transactionHash),
    ).resolves.toMatchObject({ status: 'PAID', transactionHash });
    return paid;
  }
});

function createRouting(network: 'arc-mainnet') {
  const values: Record<string, unknown> = {
    'arcNetwork.key': network,
    'arcNetwork.chainId': 5_042,
    'arcNetwork.tokens.USDC.address': OFFLINE_USDC,
    'arcNetwork.tokens.EURC.address': OFFLINE_EURC,
    arcCapabilities: {
      send: true,
      sameTokenPayroll: true,
      invoice: true,
      paymentLink: true,
      liquidity: false,
      bridge: false,
      swap: false,
      crossTokenPayroll: false,
      crossTokenInvoice: false,
      nanoAgentApi: false,
    },
  };
  return new PaymentRoutingService({
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (values[key] === undefined) throw new Error(`Missing ${key}`);
      return values[key];
    }),
  } as unknown as ConfigService);
}

function sendInput(reference: string, sourceWallet: string, recipient: string) {
  return {
    network: 'arc-mainnet' as const,
    operation: 'SEND' as const,
    sourceWallet,
    recipient,
    tokenIn: OFFLINE_USDC,
    tokenOut: OFFLINE_USDC,
    amountUnits: '1000000',
    externalReference: reference,
  };
}

async function completeDirect(
  intents: ExecutionIntentService,
  id: string,
  hash: Hex,
  sourceWallet: string,
  recipient: string,
) {
  await intents.beginVerification(id);
  return intents.completeWithVerifiedReceipt(
    id,
    directReceipt(hash, sourceWallet, recipient),
  );
}

function directReceipt(
  transactionHash: Hex,
  sourceWallet: string,
  recipient: string,
) {
  return {
    network: 'arc-mainnet' as const,
    transactionHash,
    sourceWallet,
    recipient,
    token: OFFLINE_USDC,
    amountUnits: '1000000',
  };
}
