import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { BlockchainService } from '../adapters/blockchain.service';
import { CircleService } from '../adapters/circle.service';
import { StablefxExecutionService } from '../user-swap/stablefx-execution.service';
import type { PayrollFxOperation } from './payroll-fx-operation.types';
import type { PayrollFxApprovalReconciliation } from './payroll-fx-recovery.types';
import { PayrollFxStablefxEvidenceReader } from './payroll-fx-stablefx-evidence';

@Injectable()
export class PayrollFxStablefxReconciler {
  private readonly evidence = new PayrollFxStablefxEvidenceReader();

  constructor(
    private readonly stablefx: StablefxExecutionService,
    private readonly circle: CircleService,
    private readonly blockchain: BlockchainService,
  ) {}

  async reconcileApproval(
    operation: PayrollFxOperation,
  ): Promise<PayrollFxApprovalReconciliation> {
    if (!operation.approvalTargetAddress) {
      throw new ServiceUnavailableException({
        code: 'PAYROLL_FX_RECOVERY_EVIDENCE_MISSING',
        message:
          'Payroll FX approval target was not persisted; approval recovery is fail-closed.',
      });
    }
    const allowance = await this.blockchain.getAllowance(
      operation.treasuryWalletAddress,
      operation.approvalTargetAddress,
      operation.sourceTokenAddress,
    );
    const transaction = operation.approvalTransactionId
      ? await this.circle.getTransactionStatus(operation.approvalTransactionId)
      : null;
    return {
      allowanceSufficient:
        BigInt(allowance.allowance) >= BigInt(operation.amountInBaseUnits),
      transaction,
    };
  }

  readTrade(operation: PayrollFxOperation): Promise<Record<string, unknown>> {
    if (!operation.providerOperationId) {
      throw new ServiceUnavailableException({
        code: 'PAYROLL_FX_TRADE_ID_MISSING',
        message:
          'StableFX trade submission may have occurred without a durable trade ID.',
      });
    }
    return this.stablefx.getTrade(operation.providerOperationId);
  }

  fundingIsProven(trade: Record<string, unknown>): boolean {
    if (this.evidence.extractSettlementHash(trade)) return true;
    const status = this.evidence.resolveStatus(trade).toLowerCase();
    return (
      status.includes('funded') ||
      status.includes('settlement') ||
      ['complete', 'completed', 'settled'].includes(status)
    );
  }

  readPayout(transactionId: string) {
    return this.circle.getTransactionStatus(transactionId);
  }
}
