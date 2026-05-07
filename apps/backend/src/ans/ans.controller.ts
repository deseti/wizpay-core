import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { AnsService } from './ans.service';

@Controller('ans')
export class AnsController {
  constructor(private readonly ansService: AnsService) {}

  @Get('support')
  getSupport() {
    return {
      data: this.ansService.getSupportedNamespaces(),
    };
  }

  @Get('resolve')
  async resolveDomain(@Query('domain') domain?: string) {
    const normalizedDomain = domain?.trim();
    if (!normalizedDomain) {
      throw new BadRequestException('domain query parameter is required');
    }

    return {
      data: await this.ansService.inspectDomain(normalizedDomain),
    };
  }

  @Get('metadata')
  async resolveMetadata(
    @Query('domain') domain?: string,
    @Query('key') key?: string,
  ) {
    const normalizedDomain = domain?.trim();
    const normalizedKey = key?.trim();

    if (!normalizedDomain) {
      throw new BadRequestException('domain query parameter is required');
    }

    if (!normalizedKey) {
      throw new BadRequestException('key query parameter is required');
    }

    return {
      data: {
        domain: normalizedDomain,
        key: normalizedKey,
        value: await this.ansService.resolveAgentMetadata(
          normalizedDomain,
          normalizedKey,
        ),
      },
    };
  }
}