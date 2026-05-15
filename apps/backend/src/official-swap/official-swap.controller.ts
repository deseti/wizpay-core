import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { OfficialSwapExecuteDto } from './dto/official-swap-execute.dto';
import { OfficialSwapQuoteDto } from './dto/official-swap-quote.dto';
import { OfficialSwapRuntimeService } from './official-swap-runtime.service';
import { OfficialSwapOrchestrator } from './official-swap.orchestrator';
import { OFFICIAL_SWAP_ERROR_CODES } from './official-swap.types';

@Controller('official-swap')
@UsePipes(
  new ValidationPipe({
    exceptionFactory: (errors) => {
      const missingMinOutput = errors.some(
        (error) => error.property === 'minOutput',
      );

      if (missingMinOutput) {
        return new BadRequestException({
          code: OFFICIAL_SWAP_ERROR_CODES.MIN_OUTPUT_REQUIRED,
          message: 'minOutput is required before official swap execution.',
        });
      }

      return new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Request validation failed',
      });
    },
    forbidNonWhitelisted: true,
    transform: true,
    whitelist: true,
  }),
)
export class OfficialSwapController {
  constructor(
    private readonly officialSwapOrchestrator: OfficialSwapOrchestrator,
    private readonly officialSwapRuntimeService: OfficialSwapRuntimeService,
  ) {}

  @Post('quote')
  async quote(@Body() body: OfficialSwapQuoteDto) {
    return {
      data: await this.officialSwapOrchestrator.quote(body),
    };
  }

  @Post('execute')
  async execute(@Body() body: OfficialSwapExecuteDto) {
    return {
      data: await this.officialSwapOrchestrator.execute(body),
    };
  }

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
