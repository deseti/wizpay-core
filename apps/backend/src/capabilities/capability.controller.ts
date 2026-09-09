import { Controller, Get } from '@nestjs/common';
import { CapabilityService } from './capability.service';

@Controller('capabilities')
export class CapabilityController {
  constructor(private readonly capabilities: CapabilityService) {}

  @Get()
  getCapabilities() {
    return { data: this.capabilities.response() };
  }
}
