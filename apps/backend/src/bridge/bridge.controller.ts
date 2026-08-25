import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  ValidationPipe,
} from '@nestjs/common';
import { BridgeLifecycleService } from './bridge-lifecycle.service';
import {
  BridgeWalletDto,
  AuthorizeBridgeDestinationDto,
  CreateBridgeIntentDto,
  ReportBridgeApprovalDto,
  ReportBridgeDestinationDto,
  ReportBridgeSourceDto,
  SubmitBridgeDestinationDto,
} from './dto/bridge-intent.dto';

@Controller('bridge')
export class BridgeController {
  constructor(private readonly lifecycle: BridgeLifecycleService) {}

  @Post('intents')
  createIntent(
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: CreateBridgeIntentDto,
  ) {
    return this.wrap(this.lifecycle.createIntent(body));
  }

  @Get('intents/:id')
  getIntent(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Query(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    query: BridgeWalletDto,
  ) {
    return this.wrap(this.lifecycle.getIntent(id, query));
  }

  @Post('intents/:id/approval')
  reportApproval(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: ReportBridgeApprovalDto,
  ) {
    return this.wrap(this.lifecycle.reportApproval(id, body));
  }

  @Post('intents/:id/source')
  reportSource(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: ReportBridgeSourceDto,
  ) {
    return this.wrap(this.lifecycle.reportSource(id, body));
  }

  @Post('intents/:id/attestation')
  getAttestation(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: BridgeWalletDto,
  ) {
    return this.wrap(this.lifecycle.getAttestation(id, body));
  }

  @Post('intents/:id/reattest')
  reattest(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: BridgeWalletDto,
  ) {
    return this.wrap(this.lifecycle.reattest(id, body));
  }

  @Post('intents/:id/destination')
  reportDestination(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: ReportBridgeDestinationDto,
  ) {
    return this.wrap(this.lifecycle.reportDestination(id, body));
  }

  @Post('intents/:id/destination/authorize')
  authorizeDestination(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: AuthorizeBridgeDestinationDto,
  ) {
    return this.wrap(this.lifecycle.authorizeDestination(id, body));
  }

  @Post('intents/:id/destination/submitted')
  submitDestination(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: SubmitBridgeDestinationDto,
  ) {
    return this.wrap(this.lifecycle.submitDestination(id, body));
  }

  @Post('intents/:id/destination/verify')
  verifyDestination(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    )
    body: BridgeWalletDto,
  ) {
    return this.wrap(this.lifecycle.verifyDestination(id, body));
  }

  private async wrap<T>(value: Promise<T>) {
    return { data: await value };
  }
}
