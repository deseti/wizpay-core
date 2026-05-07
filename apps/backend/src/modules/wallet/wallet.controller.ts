import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  InternalServerErrorException,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { WalletProvisionError, WalletService } from './wallet.service';

type WalletSessionBody = {
  email?: string | null;
  userId?: string | null;
  userToken?: string;
};

type EnsureWalletBody = WalletSessionBody & {
  chain?: 'EVM' | 'SOLANA';
};

@Controller('wallets')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  @Post('initialize')
  async initialize(@Body() body: WalletSessionBody) {
    const userToken = getRequiredUserToken(body.userToken);

    try {
      return {
        data: await this.walletService.initializeWallets({
          email: body.email ?? null,
          userId: body.userId ?? null,
          userToken,
        }),
      };
    } catch (error) {
      throw mapWalletControllerError(error);
    }
  }

  @Post('sync')
  async sync(@Body() body: WalletSessionBody) {
    const userToken = getRequiredUserToken(body.userToken);

    try {
      return {
        data: await this.walletService.syncWallets({
          email: body.email ?? null,
          userId: body.userId ?? null,
          userToken,
        }),
      };
    } catch (error) {
      throw mapWalletControllerError(error);
    }
  }

  @Post('ensure')
  async ensure(@Body() body: EnsureWalletBody) {
    const userToken = getRequiredUserToken(body.userToken);

    if (body.chain !== 'EVM' && body.chain !== 'SOLANA') {
      throw new BadRequestException('Missing required field: chain');
    }

    try {
      return {
        data: await this.walletService.getOrCreateWallet({
          chain: body.chain,
          email: body.email ?? null,
          userId: body.userId ?? null,
          userToken,
        }),
      };
    } catch (error) {
      throw mapWalletControllerError(error);
    }
  }
}

function getRequiredUserToken(userToken: string | undefined) {
  if (typeof userToken !== 'string' || !userToken.trim()) {
    throw new BadRequestException('Missing required field: userToken');
  }

  return userToken.trim();
}

function mapWalletControllerError(error: unknown) {
  if (error instanceof HttpException) {
    return error;
  }

  if (isDatabaseUnavailableError(error)) {
    return new ServiceUnavailableException({
      error:
        'Circle wallet sync reached the backend, but the backend could not reach Postgres to persist wallet state.',
      code: 'DATABASE_UNREACHABLE',
      details:
        'If you are running apps/backend directly on the host, start Docker Compose Postgres or point DATABASE_URL at 127.0.0.1:15432 instead of the docker-only postgres hostname.',
    });
  }

  if (error instanceof WalletProvisionError) {
    return new HttpException(
      {
        error: error.message,
        ...(typeof error.code !== 'undefined'
          ? { code: String(error.code) }
          : {}),
        ...(typeof error.details !== 'undefined'
          ? { details: error.details }
          : {}),
      },
      error.status,
    );
  }

  if (error instanceof Error) {
    return new InternalServerErrorException(error.message);
  }

  return new InternalServerErrorException(
    'Unexpected wallet provisioning error',
  );
}

function isDatabaseUnavailableError(error: unknown) {
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return true;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === 'P1001' || error.code === 'P1002';
  }

  return (
    error instanceof Error &&
    /Can't reach database server|DatabaseNotReachable|getaddrinfo ENOTFOUND postgres/i.test(
      error.message,
    )
  );
}