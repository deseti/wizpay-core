import type { PrismaClient, ExecutionIntentStatus } from '@prisma/client';

// Database-only synthetic fixtures. No application service or chain client is used.
export const fixtureId = (value: number) =>
  `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
export const fixtureHash = (value: number) =>
  `0x${value.toString(16).padStart(64, '0')}`;
const wallet = (value: number) => `0x${value.toString(16).padStart(40, '0')}`;
const owner = 'phase7-fake-owner';
const time = new Date('2026-10-01T12:34:56.789Z');
const expired = new Date('2026-09-01T12:34:56.789Z');
const future = new Date('2099-10-01T12:34:56.789Z');
const timestamps = { createdAt: time, updatedAt: time };
const large =
  '115792089237316195423570985008687907853269984665640564039457584007913129639935';

export async function seedRehearsalFixtures(prisma: PrismaClient) {
  await prisma.userWallet.createMany({
    data: [1, 2].map((value) => ({
      id: fixtureId(value),
      userId: value === 1 ? owner : 'phase7-fake-recipient',
      userEmail: value === 1 ? 'fake@example.invalid' : null,
      chain: 'EVM',
      blockchain: 'ARC-MAINNET',
      walletId: `fake-external-wallet-${value}`,
      address: wallet(value),
      walletSetId: null,
      ...timestamps,
    })),
  });
  await prisma.task.createMany({
    data: [10, 11].map((value) => ({
      id: fixtureId(value),
      type: value === 10 ? 'PAYROLL' : 'USER_SWAP',
      status: value === 10 ? 'COMPLETED' : 'PENDING',
      totalUnits: 2,
      completedUnits: value === 10 ? 2 : 0,
      failedUnits: 0,
      payload: {
        network: 'arc-mainnet',
        owner,
        wallet: wallet(1),
        amountUnits: large,
        userSigned: true,
      },
      metadata: {
        unicode: 'Rehearsal ✓',
        nested: { nullable: null, array: [1, '2', false] },
      },
      result:
        value === 10
          ? { transactionHash: fixtureHash(1), verified: true }
          : undefined,
      ...timestamps,
    })),
  });
  await prisma.taskLog.createMany({
    data: [12, 13].map((value) => ({
      id: fixtureId(value),
      taskId: fixtureId(10),
      level: 'INFO',
      step: 'receipt_verification',
      status: 'COMPLETED',
      message: 'Synthetic database evidence only',
      context: { hash: fixtureHash(1) },
      createdAt: time,
    })),
  });
  await prisma.taskUnit.createMany({
    data: [14, 15, 16].map((value, index) => ({
      id: fixtureId(value),
      taskId: fixtureId(index < 2 ? 10 : 11),
      type: index < 2 ? 'payroll_recipient' : 'user_swap',
      index: index < 2 ? index : 0,
      status: index < 2 ? 'COMPLETED' : 'PENDING',
      txHash: index < 2 ? fixtureHash(index + 1) : null,
      error: null,
      payload: { recipient: wallet(index + 2), amountUnits: large },
      ...timestamps,
    })),
  });
  await prisma.taskTransaction.createMany({
    data: [17, 18, 19].map((value, index) => ({
      id: fixtureId(value),
      taskId: fixtureId(index < 2 ? 10 : 11),
      txId: `synthetic-reported-${value}`,
      recipient: wallet(index + 2),
      amount: '123456789012345678901234567890.123456',
      currency: 'USDC',
      status: index < 2 ? 'completed' : 'pending',
      txHash: index < 2 ? fixtureHash(index + 1) : null,
      batchIndex: index,
      pollAttempts: index + 2,
      ...timestamps,
    })),
  });
  const statuses: ExecutionIntentStatus[] = [
    'CREATED',
    'AWAITING_WALLET_SIGNATURE',
    'AUTHORIZATION_PENDING',
    'SUBMISSION_PENDING',
    'SUBMITTED',
    'VERIFYING',
    'COMPLETED',
    'FAILED_RETRYABLE',
    'FAILED_FINAL',
    'EXPIRED',
    'CANCELLED',
  ];
  await prisma.executionIntent.createMany({
    data: statuses.map((status, index) => ({
      id: fixtureId(30 + index),
      network: 'arc-mainnet',
      operation:
        index === 5 ? 'PAYROLL' : index === 7 ? 'INVOICE_SETTLEMENT' : 'SEND',
      ownerId: owner,
      walletId: 'fake-external-wallet-1',
      sourceWallet: wallet(1),
      recipient: index === 5 ? null : wallet(2),
      batchDigest: index === 5 ? fixtureHash(20) : null,
      tokenIn: wallet(3),
      tokenOut: wallet(3),
      amountUnits: index === 6 ? large : '1000000',
      externalReference: `fake-reference-${index}`,
      logicalKey: `fake-logical-${index}`,
      requestFingerprint: `fake-fingerprint-${index}`,
      idempotencyKey: fixtureId(50 + index),
      route: 'DIRECT_TRANSFER',
      provider: index === 5 ? 'synthetic-user-wallet' : null,
      contractAddress: index === 5 ? wallet(99) : null,
      calldataHash: index === 5 ? fixtureHash(50) : null,
      status,
      taskId: index === 5 ? fixtureId(10) : null,
      transactionHash:
        index >= 4 && index <= 8 ? fixtureHash(30 + index) : null,
      circleChallengeId: index === 2 ? 'synthetic-challenge' : null,
      circleTransactionId: index === 2 ? 'synthetic-transaction' : null,
      leaseOwner: index === 5 ? 'fake-expired-lease' : null,
      leaseExpiresAt: index === 5 ? expired : null,
      attemptCount: index,
      failureCode: index >= 7 ? 'SYNTHETIC_FAILURE' : null,
      completedAt: status === 'COMPLETED' ? time : null,
      ...timestamps,
    })),
  });
  await prisma.invoice.createMany({
    data: [70, 71, 72].map((value) => ({
      id: fixtureId(value),
      publicId: `fake-invoice-${value}`,
      merchantUserId: owner,
      merchantWalletAddress: wallet(1),
      chainId: 5042,
      tokenAddress: wallet(3),
      tokenSymbol: 'USDC',
      tokenDecimals: 6,
      amountUnits: value === 70 ? large : '1000000',
      title: 'Synthetic migration invoice',
      description: null,
      settlementKind: value === 71 ? 'PAYMENT_LINK' : 'INVOICE',
      status: value === 72 ? 'OPEN' : 'PAID',
      paidAt: value === 72 ? null : time,
      expiresAt: future,
      ...timestamps,
    })),
  });
  await prisma.invoicePayment.createMany({
    data: [73, 74].map((value, index) => ({
      id: fixtureId(value),
      invoiceId: fixtureId(70 + index),
      transactionHash: fixtureHash(value),
      payerAddress: wallet(2),
      status: 'VERIFIED',
      submittedAt: time,
      verifiedAt: time,
      ...timestamps,
    })),
  });
  await prisma.activityAuthSession.createMany({
    data: [80, 81].map((value) => ({
      id: fixtureId(value),
      sessionHash: `synthetic-hash-${value}`,
      ownerUserId: owner,
      walletAddress: wallet(1),
      expiresAt: future,
      revokedAt: value === 81 ? time : null,
      lastUsedAt: time,
      ...timestamps,
    })),
  });
  await prisma.walletAuthChallenge.createMany({
    data: [82, 83].map((value) => ({
      id: fixtureId(value),
      nonceHash: `synthetic-nonce-hash-${value}`,
      walletAddress: wallet(1),
      chainId: 5042,
      message: 'Synthetic expired challenge; not valid for authentication',
      expiresAt: expired,
      usedAt: value === 82 ? time : null,
      createdAt: time,
    })),
  });
  await prisma.bridgeTransaction.createMany({
    data: [90, 91].map((value) => ({
      id: fixtureId(value),
      taskId: `fake-bridge-reference-${value}`,
      status: value === 90 ? 'completed' : 'attestation_pending',
      payload: {
        sourceCode: 'BASE-MAINNET',
        destinationCode: 'ARC-MAINNET',
        owner,
        walletAddress: wallet(1),
        sourceTransactionHash: fixtureHash(value),
        amountUnits: large,
      },
      result:
        value === 90
          ? { transactionHash: fixtureHash(value + 10), verified: true }
          : undefined,
      messageHash: fixtureHash(value + 20),
      nonce: `${value}${large}`,
      destinationTransactionHash: value === 90 ? fixtureHash(value + 10) : null,
      destinationLeaseId: value === 91 ? fixtureId(92) : null,
      destinationLeaseExpiresAt: value === 91 ? expired : null,
      ...timestamps,
    })),
  });
  await prisma.verifiedSwapTransaction.createMany({
    data: [110, 111].map((value) => ({
      id: fixtureId(value),
      transactionHash: fixtureHash(value),
      walletAddress: wallet(1),
      chainId: 5042,
      tokenIn: wallet(3),
      tokenOut: wallet(4),
      amountIn: large,
      amountOut: '999999999999999999999999999999999999',
      completedAt: time,
      ...timestamps,
    })),
  });
  await prisma.activity.createMany({
    data: [120, 121, 122].map((value, index) => ({
      id: fixtureId(value),
      ownerUserId: owner,
      walletAddress: wallet(1),
      type: ['send', 'invoice_payment', 'bridge'][index],
      direction: index === 1 ? 'incoming' : 'outgoing',
      status: 'completed',
      source: 'phase7_fixture',
      idempotencyKey: `fake-activity-${value}`,
      sourceReferenceType: ['execution_intent', 'invoice', 'bridge'][index],
      sourceReferenceId: fixtureId([36, 70, 90][index]),
      chainId: 5042,
      txHash: fixtureHash([36, 73, 90][index]),
      inputAmount: large,
      metadata: { financialEvidence: 'synthetic', nullable: null },
      occurredAt: time,
      ...timestamps,
    })),
  });
  await prisma.activitySyncState.createMany({
    data: [130, 131].map((value) => ({
      id: fixtureId(value),
      ownerUserId: value === 130 ? owner : 'phase7-fake-recipient',
      walletAddress: wallet(value === 130 ? 1 : 2),
      source: 'synthetic_source',
      checkpointTransactionId: `fake-cursor-${value}`,
      leaseId: value === 130 ? 'fake-activity-lease' : null,
      leaseExpiresAt: value === 130 ? expired : null,
      lastStartedAt: time,
      lastCompletedAt: value === 131 ? time : null,
      nextAllowedAt: future,
      ...timestamps,
    })),
  });
  await prisma.reconciliationWork.createMany({
    data: [140, 141, 142, 143].map((value, index) => ({
      id: fixtureId(value),
      kind: ['INTENT', 'SWAP', 'BRIDGE', 'ACTIVITY'][index],
      recordId: fixtureId([35, 110, 91, 130][index]),
      evidenceKey: index === 3 ? 'fake-checkpoint' : fixtureHash(value),
      network: 'arc-mainnet',
      leaseToken: index === 0 || index === 2 ? fixtureId(144 + index) : null,
      leaseExpiresAt: index === 0 ? expired : index === 2 ? future : null,
      attempts: index + 3,
      availableAt: index === 2 ? future : expired,
      acknowledgedAt: index === 1 ? time : null,
      failedAt: index === 3 ? time : null,
      failureCode: index === 3 ? 'SYNTHETIC_PERMANENT' : null,
      ...timestamps,
    })),
  });
}
