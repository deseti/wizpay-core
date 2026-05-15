import { Module } from '@nestjs/common';
import { CircleAgentWalletSwapExecutor } from './executors/circle-agent-wallet-swap.executor';
import { OfficialSwapController } from './official-swap.controller';
import { OfficialSwapOrchestrator } from './official-swap.orchestrator';

@Module({
  controllers: [OfficialSwapController],
  providers: [OfficialSwapOrchestrator, CircleAgentWalletSwapExecutor],
})
export class OfficialSwapModule {}
