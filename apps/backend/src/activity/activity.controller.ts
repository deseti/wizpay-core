import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { InvoiceAuthService } from '../invoice/invoice-auth.service';
import { ActivityService } from './activity.service';

@Controller('activities')
export class ActivityController {
  constructor(
    private readonly auth: InvoiceAuthService,
    private readonly activity: ActivityService,
  ) {}

  @Get()
  async list(
    @Headers('authorization') authorization?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limitText?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
  ) {
    const principal = await this.activity.authenticateRead(authorization);
    const limit = limitText === undefined ? undefined : Number(limitText);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1))
      throw new BadRequestException('Invalid activity page size.');
    try {
      this.activity.validateListInput({ cursor, limit, type, status });
      return {
        data: await this.activity.list(principal, {
          cursor,
          limit,
          type,
          status,
        }),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith('Invalid activity')
      )
        throw new BadRequestException(error.message);
      throw error;
    }
  }

  @Get(':id')
  async get(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
  ) {
    const principal = await this.activity.authenticateRead(authorization);
    return { data: await this.activity.getOwned(principal, id) };
  }


  @Post('sync')
  async sync(@Headers('authorization') authorization?: string) {
    const principal =
      await this.auth.authenticateCirclePrincipal(authorization);
    return { data: await this.activity.sync(principal) };
  }
}
