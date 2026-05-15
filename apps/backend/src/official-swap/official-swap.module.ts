import { Module } from '@nestjs/common';
import { CircleAgentWalletSwapExecutor } from './executors/circle-agent-wallet-swap.executor';
import { OfficialSwapRuntimeService } from './official-swap-runtime.service';
import { OfficialSwapController } from './official-swap.controller';
import { OfficialSwapOrchestrator } from './official-swap.orchestrator';

@Module({
  controllers: [OfficialSwapController],
  providers: [
    OfficialSwapOrchestrator,
    OfficialSwapRuntimeService,
    CircleAgentWalletSwapExecutor,
  ],
})
export class OfficialSwapModule {}
