import { Controller, Get, Param } from '@nestjs/common';
import { OfficialSwapRuntimeService } from './official-swap-runtime.service';
import { OfficialSwapOrchestrator } from './official-swap.orchestrator';

@Controller('official-swap')
export class OfficialSwapController {
  constructor(
    private readonly officialSwapOrchestrator: OfficialSwapOrchestrator,
    private readonly officialSwapRuntimeService: OfficialSwapRuntimeService,
  ) {}

  @Get('runtime')
  async getRuntime() {
    return {
      data: await this.officialSwapRuntimeService.getRuntimeStatus(),
    };
  }

  @Get(':operationId/status')
  getStatus(@Param('operationId') operationId: string) {
    return {
      data: this.officialSwapOrchestrator.getStatus(operationId),
    };
  }
}
