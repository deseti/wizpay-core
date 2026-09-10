import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ExecutionIntentService } from './execution-intent.service';
import { ExecutionIntentController } from './execution-intent.controller';
import { DirectTransferReceiptVerifierService } from './direct-transfer-receipt-verifier.service';

@Global()
@Module({
  imports: [DatabaseModule],
  controllers: [ExecutionIntentController],
  providers: [ExecutionIntentService, DirectTransferReceiptVerifierService],
  exports: [ExecutionIntentService],
})
export class ExecutionIntentModule {}
