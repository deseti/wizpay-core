import {
  BadRequestException,
  Body,
  Controller,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { UserSwapQuoteDto } from './dto/user-swap-quote.dto';
import { UserSwapService } from './user-swap.service';
import { USER_SWAP_ERROR_CODES } from './user-swap.types';
import { CapabilityService } from '../capabilities/capability.service';

@Controller('user-swap')
@UsePipes(
  new ValidationPipe({
    exceptionFactory: () =>
      new BadRequestException({
        code: USER_SWAP_ERROR_CODES.INVALID_REQUEST,
        message: 'User swap request validation failed.',
      }),
    forbidNonWhitelisted: true,
    transform: true,
    whitelist: true,
  }),
)
export class UserSwapController {
  constructor(
    private readonly userSwapService: UserSwapService,
    private readonly capabilities: CapabilityService,
  ) {}

  @Post('quote')
  async quote(@Body() body: UserSwapQuoteDto) {
    this.capabilities.assert('swap');
    return {
      data: await this.userSwapService.quote(body),
    };
  }
}
