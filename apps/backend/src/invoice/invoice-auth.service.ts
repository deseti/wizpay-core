import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAddress, isAddress, isAddressEqual } from 'viem';
import { PrismaService } from '../database/prisma.service';
import { resolveCircleConfigurationFromService } from '../config/circle-execution.config';
import {
  INVOICE_ERROR_CODES,
  type InvoiceMerchantPrincipal,
} from './invoice.types';

type CircleUser = { id?: string; status?: string };
type CircleWallet = {
  id?: string;
  userId?: string;
  address?: string;
  blockchain?: string;
  walletSetId?: string | null;
};

export type AuthenticatedCirclePrincipal = InvoiceMerchantPrincipal & {
  circleWalletId: string;
  userToken: string;
};

@Injectable()
export class InvoiceAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async authenticate(
    authorization?: string,
  ): Promise<InvoiceMerchantPrincipal> {
    const principal = await this.authenticateCirclePrincipal(authorization);
    return {
      merchantUserId: principal.merchantUserId,
      merchantWalletAddress: principal.merchantWalletAddress,
      merchantDisplayLabel: principal.merchantDisplayLabel,
    };
  }

  async authenticateCirclePrincipal(
    authorization?: string,
  ): Promise<AuthenticatedCirclePrincipal> {
    const userToken = this.extractBearerToken(authorization);
    const circle = resolveCircleConfigurationFromService(
      this.config,
      'user-controlled',
    );
    const user = await this.circleRequest<CircleUser>(
      '/v1/w3s/user',
      userToken,
    );
    const circleUserId = this.requiredString(user.id);
    if (!circleUserId) {
      throw this.unauthorized(
        INVOICE_ERROR_CODES.AUTH_IDENTITY_MISSING,
        'Circle did not return an authenticated user identity.',
      );
    }
    if (user.status?.toUpperCase() !== 'ENABLED') {
      throw this.unauthorized(
        INVOICE_ERROR_CODES.AUTH_INVALID,
        'The Circle user session is not enabled.',
      );
    }

    const merchantUserId = `circle:user:${circleUserId}`;
    const storedEvmWallets = await this.prisma.userWallet.findMany({
      where: {
        userId: merchantUserId,
        blockchain: circle.blockchain,
      },
      orderBy: { blockchain: 'asc' },
    });
    const arcWallet = storedEvmWallets.find(
      (wallet) => wallet.blockchain === circle.blockchain,
    );
    if (!arcWallet) {
      throw this.unauthorized(
        INVOICE_ERROR_CODES.WALLET_MISSING,
        'An authenticated canonical Arc App Wallet is required.',
      );
    }

    const addresses = storedEvmWallets.map((wallet) => wallet.address);
    if (addresses.some((address) => !isAddress(address))) {
      throw this.unauthorized(
        INVOICE_ERROR_CODES.WALLET_CONFLICT,
        'Stored App Wallet address data is invalid.',
      );
    }
    const canonical = getAddress(arcWallet.address);
    if (
      addresses.some(
        (address) => !isAddressEqual(getAddress(address), canonical),
      )
    ) {
      throw this.unauthorized(
        INVOICE_ERROR_CODES.WALLET_CONFLICT,
        'Stored App Wallet EVM addresses conflict.',
      );
    }

    const walletResponse = await this.circleRequest<{
      wallets?: CircleWallet[];
    }>('/v1/w3s/wallets?pageSize=50', userToken);
    const upstream = (walletResponse.wallets ?? []).filter(
      (wallet) => wallet.blockchain === circle.blockchain,
    );
    if (upstream.length !== 1) {
      throw this.unauthorized(
        INVOICE_ERROR_CODES.WALLET_OWNERSHIP_UNPROVEN,
        'Circle did not prove one canonical Arc wallet for this user.',
      );
    }
    const proven = upstream[0];
    if (
      proven.id !== arcWallet.walletId ||
      proven.userId !== circleUserId ||
      (circle.walletSetId !== null &&
        (arcWallet.walletSetId !== circle.walletSetId ||
          proven.walletSetId !== circle.walletSetId)) ||
      !proven.address ||
      !isAddress(proven.address) ||
      !isAddressEqual(getAddress(proven.address), canonical)
    ) {
      throw this.unauthorized(
        INVOICE_ERROR_CODES.WALLET_OWNERSHIP_UNPROVEN,
        'Circle wallet ownership does not match the persisted Arc wallet.',
      );
    }

    return {
      merchantUserId,
      merchantWalletAddress: canonical,
      merchantDisplayLabel: null,
      circleWalletId: arcWallet.walletId,
      userToken,
    };
  }

  private extractBearerToken(authorization?: string) {
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    if (!match)
      throw this.unauthorized(
        INVOICE_ERROR_CODES.AUTH_REQUIRED,
        'A Circle user bearer token is required.',
      );
    return match[1];
  }

  private async circleRequest<T>(path: string, userToken: string): Promise<T> {
    const circle = resolveCircleConfigurationFromService(
      this.config,
      'user-controlled',
    );
    try {
      const response = await fetch(`${circle.apiBaseUrl}${path}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${circle.apiKey}`,
          'X-User-Token': userToken,
        },
      });
      const payload = (await response.json().catch(() => ({}))) as { data?: T };
      if (!response.ok || !payload.data)
        throw new Error('Circle authentication rejected the session.');
      return payload.data;
    } catch {
      throw this.unauthorized(
        INVOICE_ERROR_CODES.AUTH_INVALID,
        'Circle authentication failed. Sign in again and retry.',
      );
    }
  }

  private requiredString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private unauthorized(code: string, message: string) {
    return new UnauthorizedException({ code, message });
  }
}
