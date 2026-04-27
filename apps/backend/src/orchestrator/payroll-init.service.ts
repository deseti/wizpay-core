import { BadRequestException, Injectable } from '@nestjs/common';
import { PayrollBatchService } from '../agents/payroll/payroll-batch.service';
import { PayrollValidationService } from '../agents/payroll/payroll-validation.service';

type PayrollInitBatchRecipient = {
  address: string;
  amount: string;
  targetToken: string;
};

type PayrollInitBatch = {
  index: number;
  referenceId: string;
  recipientCount: number;
  totalAmount: string;
  recipients: PayrollInitBatchRecipient[];
};

type PayrollInitPlan = {
  sourceToken: string;
  referenceId: string;
  approvalAmount: string;
  totals: {
    totalAmount: string;
    totalRecipients: number;
    totalBatches: number;
  };
  batches: PayrollInitBatch[];
};

@Injectable()
export class PayrollInitService {
  constructor(
    private readonly validationService: PayrollValidationService,
    private readonly batchService: PayrollBatchService,
  ) {}

  async prepare(payload: Record<string, unknown>): Promise<PayrollInitPlan> {
    const validation = await this.validationService.validate(payload);

    if (!validation.valid) {
      throw new BadRequestException({
        code: 'PAYROLL_INIT_INVALID',
        details: validation.errors,
        error: 'Payroll init validation failed.',
      });
    }

    const batches = this.batchService.splitIntoBatches(validation.recipients);
    const totals = this.batchService.calculateTotals(batches);
    const sourceToken =
      typeof payload.sourceToken === 'string' && payload.sourceToken.trim()
        ? payload.sourceToken.trim()
        : 'USDC';
    const referenceId = this.normalizeReferenceId(payload.referenceId);

    return {
      sourceToken,
      referenceId,
      approvalAmount: totals.totalAmount.toString(),
      totals: {
        totalAmount: totals.totalAmount.toString(),
        totalRecipients: totals.totalRecipients,
        totalBatches: totals.totalBatches,
      },
      batches: batches.map((batch) => ({
        index: batch.index,
        referenceId: this.getBatchReferenceId(referenceId, batch.index),
        recipientCount: batch.recipients.length,
        totalAmount: batch.totalAmount.toString(),
        recipients: batch.recipients.map((recipient) => ({
          address: recipient.address,
          amount: recipient.amount,
          targetToken: recipient.targetToken,
        })),
      })),
    };
  }

  private normalizeReferenceId(referenceId: unknown) {
    if (typeof referenceId === 'string' && referenceId.trim()) {
      return referenceId.trim();
    }

    return `PAY-${Date.now()}`;
  }

  private getBatchReferenceId(baseReferenceId: string, batchIndex: number) {
    if (batchIndex === 0) {
      return baseReferenceId;
    }

    const matchedSuffix = baseReferenceId.match(/(.*)-(\d+)$/);

    if (matchedSuffix) {
      return `${matchedSuffix[1]}-${parseInt(matchedSuffix[2], 10) + batchIndex}`;
    }

    return `${baseReferenceId}-${batchIndex + 1}`;
  }
}
