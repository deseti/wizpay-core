import { Injectable } from '@nestjs/common';
import { Prisma, type ReconciliationWork } from '@prisma/client';
import { getAddress, parseUnits, type Hex } from 'viem';
import { PrismaService } from '../database/prisma.service';
import {
  ExecutionIntentService,
  type VerifiedExecutionReceipt,
} from '../execution-intent/execution-intent.service';
import { DirectTransferReceiptVerifierService } from '../execution-intent/direct-transfer-receipt-verifier.service';
import { PayrollReceiptVerifierService } from '../task/payroll-receipt-verifier.service';
import { TaskUnitService } from '../task/task-unit.service';
import { InvoicePaymentVerifierService } from '../invoice/invoice-payment-verifier.service';
import { MainnetUniswapV4Service } from '../user-swap/mainnet-uniswap-v4.service';
import { BridgeLifecycleService } from '../bridge/bridge-lifecycle.service';
import { ActivityService } from '../activity/activity.service';
import { PaymentRoutingService } from '../routing/payment-routing.service';
import {
  RecoveryDeferred,
  RecoveryRejected,
} from './postgres-delivery.service';

export type DurableRecovery = (tx: Prisma.TransactionClient) => Promise<void>;
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function knownHash(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
}
const TERMINAL = ['COMPLETED', 'FAILED_FINAL', 'EXPIRED', 'CANCELLED'];

@Injectable()
export class RecoveryVerifierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly direct: DirectTransferReceiptVerifierService,
    private readonly payroll: PayrollReceiptVerifierService,
    private readonly invoices: InvoicePaymentVerifierService,
    private readonly swaps: MainnetUniswapV4Service,
    private readonly bridges: BridgeLifecycleService,
    private readonly units: TaskUnitService,
    private readonly routing: PaymentRoutingService,
  ) {}

  async prepare(work: ReconciliationWork): Promise<DurableRecovery> {
    if (
      work.network !== 'arc-mainnet' ||
      this.routing.network !== 'arc-mainnet' ||
      this.routing.chainId !== 5042
    )
      throw new RecoveryRejected('RECOVERY_NETWORK_MISMATCH');
    if (work.kind === 'INTENT') return this.intent(work);
    if (work.kind === 'SWAP') return this.swap(work);
    if (work.kind === 'BRIDGE') return this.bridge(work);
    if (work.kind === 'ACTIVITY') return this.activity(work);
    throw new RecoveryRejected('RECOVERY_KIND_INVALID');
  }

  private async intent(work: ReconciliationWork): Promise<DurableRecovery> {
    const intent = await this.prisma.executionIntent.findUnique({
      where: { id: work.recordId },
    });
    if (!intent) return () => Promise.resolve();
    if (intent.network !== 'arc-mainnet')
      throw new RecoveryRejected('RECOVERY_NETWORK_MISMATCH');
    if (TERMINAL.includes(intent.status) && intent.status !== 'COMPLETED')
      return () => Promise.resolve();
    if (
      !knownHash(intent.transactionHash) ||
      intent.transactionHash.toLowerCase() !== work.evidenceKey
    )
      throw new RecoveryRejected('RECOVERY_HASH_REQUIRED');
    if (
      !['SUBMITTED', 'VERIFYING', 'FAILED_RETRYABLE', 'COMPLETED'].includes(
        intent.status,
      )
    )
      throw new RecoveryDeferred('RECOVERY_INTENT_NOT_ELIGIBLE');
    if (intent.status !== 'COMPLETED') {
      const now = new Date();
      const claimed = await this.prisma.executionIntent.updateMany({
        where: {
          id: intent.id,
          transactionHash: intent.transactionHash,
          network: 'arc-mainnet',
          status: { in: ['SUBMITTED', 'VERIFYING', 'FAILED_RETRYABLE'] },
          OR: [
            { leaseOwner: null },
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          leaseOwner: work.leaseToken,
          leaseExpiresAt: work.leaseExpiresAt,
          attemptCount: { increment: 1 },
        },
      });
      if (claimed.count !== 1)
        throw new RecoveryDeferred('RECOVERY_INTENT_LEASE_ACTIVE');
    }
    let receipt: VerifiedExecutionReceipt;
    let unitId: string | undefined;
    let invoiceId: string | undefined;
    if (intent.operation === 'SEND') {
      if (intent.status === 'COMPLETED') return () => Promise.resolve();
      if (!intent.recipient || intent.route !== 'DIRECT_TRANSFER')
        throw new RecoveryRejected('RECOVERY_EVIDENCE_INSUFFICIENT');
      receipt = await this.direct.verify({
        transactionHash: intent.transactionHash,
        sender: intent.sourceWallet,
        recipient: intent.recipient,
        token: intent.tokenOut,
        amountUnits: intent.amountUnits,
      });
    } else if (intent.operation === 'PAYROLL') {
      if (!intent.taskId || !intent.batchDigest)
        throw new RecoveryRejected('RECOVERY_EVIDENCE_INSUFFICIENT');
      const unit = await this.prisma.taskUnit.findFirst({
        where: {
          taskId: intent.taskId,
          payload: { path: ['executionIntentId'], equals: intent.id },
        },
      });
      if (!unit) throw new RecoveryDeferred('RECOVERY_PAYROLL_UNIT_MISSING');
      if (unit.status !== 'PENDING' && intent.status === 'COMPLETED')
        return () => Promise.resolve();
      const payload = object(unit.payload);
      if (
        payload.referenceId !== intent.externalReference ||
        !Array.isArray(payload.recipients)
      )
        throw new RecoveryRejected('RECOVERY_EVIDENCE_INSUFFICIENT');
      unitId = unit.id;
      const recipients = payload.recipients.map((value: unknown) => {
        const recipient = object(value);
        if (typeof recipient.address !== 'string')
          throw new RecoveryRejected('RECOVERY_EVIDENCE_INSUFFICIENT');
        return {
          address: recipient.address,
          amountUnits:
            typeof recipient.amountUnits === 'string'
              ? recipient.amountUnits
              : parseUnits(
                  typeof recipient.amount === 'string' ? recipient.amount : '',
                  6,
                ).toString(),
        };
      });
      receipt = await this.payroll.verify({
        transactionHash: intent.transactionHash,
        sourceWallet: intent.sourceWallet,
        token: intent.tokenOut,
        totalAmountUnits: intent.amountUnits,
        expectedBatchDigest: intent.batchDigest,
        referenceId: intent.externalReference,
        recipients,
      });
    } else if (
      ['INVOICE_SETTLEMENT', 'PAYMENT_LINK_SETTLEMENT'].includes(
        intent.operation,
      )
    ) {
      const invoice = await this.prisma.invoice.findUnique({
        where: { publicId: intent.externalReference },
        include: { payment: true },
      });
      if (!invoice || ['EXPIRED', 'CANCELLED'].includes(invoice.status))
        throw new RecoveryRejected('RECOVERY_INVOICE_TERMINAL');
      if (invoice.status === 'PAID' && intent.status === 'COMPLETED')
        return () => Promise.resolve();
      if (
        (invoice.expiresAt &&
          invoice.status === 'OPEN' &&
          invoice.expiresAt <= new Date()) ||
        invoice.chainId !== 5042 ||
        (invoice.payment &&
          invoice.payment.transactionHash !== intent.transactionHash)
      )
        throw new RecoveryRejected('RECOVERY_INVOICE_CONFLICT');
      if (
        (invoice.settlementKind === 'PAYMENT_LINK') !==
        (intent.operation === 'PAYMENT_LINK_SETTLEMENT')
      )
        throw new RecoveryRejected('RECOVERY_INVOICE_CONFLICT');
      const verified = await this.invoices.verify({
        transactionHash: intent.transactionHash as Hex,
        tokenAddress: getAddress(invoice.tokenAddress),
        merchantWalletAddress: getAddress(invoice.merchantWalletAddress),
        amountUnits: invoice.amountUnits,
      });
      invoiceId = invoice.id;
      receipt = {
        network: 'arc-mainnet',
        transactionHash: verified.transactionHash,
        sourceWallet: verified.payerAddress,
        token: invoice.tokenAddress,
        recipient: invoice.merchantWalletAddress,
        amountUnits: invoice.amountUnits,
      };
    } else throw new RecoveryRejected('RECOVERY_VERIFIER_UNAVAILABLE');
    return async (tx) => {
      const current = await tx.executionIntent.findUniqueOrThrow({
        where: { id: intent.id },
      });
      if (TERMINAL.includes(current.status) && current.status !== 'COMPLETED')
        return;
      if (
        current.status !== 'COMPLETED' &&
        current.leaseOwner !== work.leaseToken
      )
        throw new RecoveryDeferred('RECOVERY_INTENT_LEASE_LOST');
      let invoiceClaimed = false;
      if (invoiceId) {
        const locked = await tx.invoice.updateMany({
          where: { id: invoiceId, status: { in: ['OPEN', 'VERIFYING'] } },
          data: { status: 'PAID', paidAt: new Date() },
        });
        invoiceClaimed = locked.count === 1;
        if (!invoiceClaimed) {
          const settled = await tx.invoice.findUniqueOrThrow({
            where: { id: invoiceId },
            include: { payment: true },
          });
          if (settled.status !== 'PAID') return; // Never reopen a terminal invoice.
          if (
            settled.payment?.status !== 'VERIFIED' ||
            settled.payment.transactionHash !== intent.transactionHash
          )
            throw new RecoveryRejected('RECOVERY_INVOICE_CONFLICT');
        }
      }
      const intents = new ExecutionIntentService(
        tx as PrismaService,
        this.routing,
      );
      await intents.beginVerification(intent.id);
      await intents.completeWithVerifiedReceipt(intent.id, receipt);
      if (unitId && intent.taskId)
        await this.units.reportUnitInTransaction(tx, intent.taskId, unitId, {
          status: 'SUCCESS',
          executionIntentId: intent.id,
          txHash: intent.transactionHash,
        });
      if (invoiceId) {
        if (invoiceClaimed) {
          const prior = await tx.invoicePayment.findUnique({
            where: { invoiceId },
          });
          if (prior && prior.transactionHash !== intent.transactionHash)
            throw new RecoveryRejected('RECOVERY_INVOICE_CONFLICT');
          await tx.invoicePayment.upsert({
            where: { invoiceId },
            create: {
              invoiceId,
              transactionHash: intent.transactionHash!,
              payerAddress: receipt.sourceWallet,
              status: 'VERIFIED',
              verifiedAt: new Date(),
            },
            update: {
              status: 'VERIFIED',
              payerAddress: receipt.sourceWallet,
              verifiedAt: new Date(),
              rejectionCode: null,
            },
          });
        }
      }
      await tx.executionIntent.updateMany({
        where: { id: intent.id, leaseOwner: work.leaseToken },
        data: { leaseOwner: null, leaseExpiresAt: null },
      });
    };
  }

  private async swap(work: ReconciliationWork): Promise<DurableRecovery> {
    if (!knownHash(work.evidenceKey))
      throw new RecoveryRejected('RECOVERY_HASH_REQUIRED');
    const stored = await this.prisma.verifiedSwapTransaction.findUnique({
      where: { transactionHash: work.evidenceKey },
    });
    if (stored) {
      if (stored.walletAddress.toLowerCase() !== work.recordId.toLowerCase())
        throw new RecoveryRejected('RECOVERY_SWAP_OWNER_CONFLICT');
      return () => Promise.resolve();
    }
    const verified = await this.swaps.confirmTransaction(
      work.evidenceKey,
      work.recordId,
    );
    return async (tx) => {
      const result = await tx.verifiedSwapTransaction.upsert({
        where: { transactionHash: verified.transactionHash },
        create: { ...verified, completedAt: new Date() },
        update: {},
      });
      if (result.walletAddress.toLowerCase() !== work.recordId.toLowerCase())
        throw new RecoveryRejected('RECOVERY_SWAP_OWNER_CONFLICT');
    };
  }

  private async bridge(work: ReconciliationWork): Promise<DurableRecovery> {
    const observed = await this.bridges.observeRecovery(work.recordId);
    if (!observed) return () => Promise.resolve();
    return async (tx) => {
      const result = await tx.bridgeTransaction.updateMany({
        where: {
          id: work.recordId,
          status: observed.row.status,
          updatedAt: observed.row.updatedAt,
        },
        data: {
          status: observed.status,
          result: observed.result,
          messageHash: observed.messageHash,
          nonce: observed.nonce,
        },
      });
      if (result.count !== 1)
        throw new RecoveryDeferred('RECOVERY_BRIDGE_CHANGED');
      if (observed.status === 'completed')
        await tx.task.updateMany({
          where: {
            id: observed.row.taskId,
            status: { notIn: ['completed', 'executed', 'failed', 'partial'] },
          },
          data: { status: 'completed' },
        });
    };
  }

  private activity(work: ReconciliationWork): Promise<DurableRecovery> {
    return Promise.resolve(async (tx) => {
      const service = new ActivityService(tx as PrismaService);
      if (
        !(await service.reconcileExistingState(
          work.recordId,
          20,
          work.evidenceKey,
        ))
      )
        throw new RecoveryDeferred('RECOVERY_ACTIVITY_LEASE_ACTIVE');
    });
  }
}
