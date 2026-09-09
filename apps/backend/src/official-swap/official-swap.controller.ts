import { Controller, Get, Param } from '@nestjs/common';
import { OfficialSwapRuntimeService } from './official-swap-runtime.service';
import { OfficialSwapOrchestrator } from './official-swap.orchestrator';
import { CapabilityService } from '../capabilities/capability.service';

@Controller('official-swap')
export class OfficialSwapController {
  constructor(
    private readonly officialSwapOrchestrator: OfficialSwapOrchestrator,
    private readonly officialSwapRuntimeService: OfficialSwapRuntimeService,
    private readonly capabilities: CapabilityService,
  ) {}

  @Get('runtime')
  async getRuntime() {
    this.capabilities.assert('swap');
    return {
      data: await this.officialSwapRuntimeService.getRuntimeStatus(),
    };
  }

  @Get(':operationId/status')
  getStatus(@Param('operationId') operationId: string) {
    this.capabilities.assert('swap');
    return {
      data: this.officialSwapOrchestrator.getStatus(operationId),
    };
  }
}
