import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
} from '@nestjs/common';
import { ExecutionIntentOperation } from '@prisma/client';
import { ExecutionIntentService } from './execution-intent.service';
import { DirectTransferReceiptVerifierService } from './direct-transfer-receipt-verifier.service';

@Controller('execution-intents')
export class ExecutionIntentController {
  constructor(
    private readonly intents: ExecutionIntentService,
    private readonly receipts: DirectTransferReceiptVerifierService,
  ) {}

  @Post('acquire')
  async acquire(@Body() body: Record<string, unknown>) {
    const operation = String(body.operation ?? '') as ExecutionIntentOperation;
    if (!Object.values(ExecutionIntentOperation).includes(operation))
      throw new BadRequestException({
        code: 'EXECUTION_INTENT_INVALID_OPERATION',
        message: 'Execution intent operation is invalid.',
      });
    return {
      data: await this.intents.acquire({
        network: body.network as 'arc-testnet' | 'arc-mainnet',
        operation,
        ownerId: null,
        sourceWallet: String(body.sourceWallet ?? ''),
        recipient: typeof body.recipient === 'string' ? body.recipient : null,
        batchDigest:
          typeof body.batchDigest === 'string' ? body.batchDigest : null,
        tokenIn: String(body.tokenIn ?? ''),
        tokenOut: String(body.tokenOut ?? ''),
        amountUnits: String(body.amountUnits ?? ''),
        externalReference: String(body.externalReference ?? ''),
      }),
    };
  }

  @Post(':id/transaction-hash')
  async bindHash(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    await this.intents.assertAccess(id, String(body.idempotencyKey ?? ''));
    return {
      data: await this.intents.bindTransactionHash(
        id,
        String(body.transactionHash ?? ''),
        String(body.leaseOwner ?? ''),
      ),
    };
  }

  @Post(':id/prepare-wallet')
  async prepareWallet(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return {
      data: await this.intents.prepareWalletSignature(
        id,
        String(body.idempotencyKey ?? ''),
        String(body.leaseOwner ?? ''),
      ),
    };
  }

  @Post(':id/recover')
  async recover(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return {
      data: await this.intents.assertAccess(
        id,
        String(body.idempotencyKey ?? ''),
      ),
    };
  }

  @Post(':id/recover-hash')
  async recoverHash(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ) {
    return {
      data: await this.intents.bindKnownTransactionHash(
        id,
        String(body.idempotencyKey ?? ''),
        String(body.transactionHash ?? ''),
      ),
    };
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return {
      data: await this.intents.cancelUnsubmitted(
        id,
        String(body.idempotencyKey ?? ''),
      ),
    };
  }

  @Post(':id/verify')
  async verify(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    await this.intents.assertAccess(id, String(body.idempotencyKey ?? ''));
    const intent = await this.intents.beginVerification(id);
    if (!intent.transactionHash || !intent.recipient)
      throw new BadRequestException({
        code: 'EXECUTION_INTENT_NOT_SUBMITTED',
        message: 'The execution intent has no submitted direct transfer.',
      });
    if (intent.operation !== 'SEND')
      throw new BadRequestException({
        code: 'EXECUTION_INTENT_VERIFIER_MISMATCH',
        message: 'This verifier supports direct Send intents only.',
      });
    const verified = await this.receipts.verify({
      transactionHash: intent.transactionHash,
      sender: intent.sourceWallet,
      recipient: intent.recipient,
      token: intent.tokenOut,
      amountUnits: intent.amountUnits,
    });
    return {
      data: await this.intents.completeWithVerifiedReceipt(id, verified),
    };
  }
}
