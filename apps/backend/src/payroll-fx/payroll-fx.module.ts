import { Module } from '@nestjs/common';
import { AdaptersModule } from '../adapters/adapters.module';
import { DatabaseModule } from '../database/database.module';
import { UserSwapModule } from '../user-swap/user-swap.module';
import { PayrollFxOperationRepository } from './payroll-fx-operation.repository';
import { PayrollFxExecutionLeaseRepository } from './payroll-fx-execution-lease.repository';
import { PayrollFxRecoveryPolicy } from './payroll-fx-recovery-policy';
import { PayrollFxStablefxLifecycleService } from './payroll-fx-stablefx-lifecycle.service';
import { PayrollFxStablefxOperationService } from './payroll-fx-stablefx-operation.service';
import { PayrollFxStablefxReconciler } from './payroll-fx-stablefx-reconciler';
import { PayrollFxStablefxRecoveryService } from './payroll-fx-stablefx-recovery.service';
import { PayrollFxTaskBindingService } from './payroll-fx-task-binding.service';
import { PayrollFxPayoutPlanRepository } from './payroll-fx-payout-plan.repository';
import { PayrollFxPayoutPlanService } from './payroll-fx-payout-plan.service';

@Module({
  imports: [AdaptersModule, DatabaseModule, UserSwapModule],
  providers: [
    PayrollFxOperationRepository,
    PayrollFxExecutionLeaseRepository,
    PayrollFxRecoveryPolicy,
    PayrollFxStablefxOperationService,
    PayrollFxStablefxReconciler,
    PayrollFxStablefxLifecycleService,
    PayrollFxStablefxRecoveryService,
    PayrollFxTaskBindingService,
    PayrollFxPayoutPlanRepository,
    PayrollFxPayoutPlanService,
  ],
  exports: [
    PayrollFxOperationRepository,
    PayrollFxStablefxLifecycleService,
    PayrollFxStablefxRecoveryService,
    PayrollFxPayoutPlanService,
  ],
})
export class PayrollFxModule {}
