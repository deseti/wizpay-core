import { Injectable, UnauthorizedException } from '@nestjs/common';
import { getAddress, isAddress } from 'viem';
import { PrismaService } from '../database/prisma.service';
import { EXTERNAL_WALLET_BLOCKCHAIN } from '../modules/wallet/wallet.service';
import {
  INVOICE_ERROR_CODES,
  type InvoiceMerchantPrincipal,
} from './invoice.types';

export type AuthenticatedWalletPrincipal = InvoiceMerchantPrincipal;

@Injectable()
export class InvoiceAuthService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Mainnet direct authentication for invoice and activity endpoints.
   *
   * The caller presents its external Arc Mainnet wallet address as an
   * opaque bearer token. The backend binds the merchant principal to the
   * matching external wallet registry record. There is no wallet-provider
   * session, no hosted wallet lookup, and no off-chain ownership proof:
   * money movement stays trust-anchored in on-chain receipt verification,
   * while invoice scoping stays bound to the registered address.
   */
  async authenticate(
    authorization?: string,
  ): Promise<InvoiceMerchantPrincipal> {
    const address = this.extractBearerAddress(authorization);
    const canonical = address.toLowerCase();
    const wallets = await this.prisma.userWallet.findMany({
      where: { blockchain: EXTERNAL_WALLET_BLOCKCHAIN },
    });
    const matches = wallets.filter(
      (wallet) => wallet.address.toLowerCase() === canonical,
    );
    if (matches.length === 0) {
      throw this.unauthorized(
        INVOICE_ERROR_CODES.WALLET_MISSING,
        'Register the external Arc Mainnet wallet before using invoices.',
      );
    }
    const owners = new Set(matches.map((wallet) => wallet.userId));
    if (owners.size !== 1) {
      throw this.unauthorized(
        INVOICE_ERROR_CODES.WALLET_CONFLICT,
        'The external wallet registry has conflicting owners for this address.',
      );
    }
    const wallet = matches[0];
    if (!isAddress(wallet.address)) {
      throw this.unauthorized(
        INVOICE_ERROR_CODES.WALLET_CONFLICT,
        'Stored external wallet address data is invalid.',
      );
    }
    return {
      merchantUserId: wallet.userId,
      merchantWalletAddress: getAddress(wallet.address),
      merchantDisplayLabel: null,
    };
  }

  private extractBearerAddress(authorization?: string) {
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    const candidate = match?.[1]?.trim() ?? '';
    if (!candidate || !isAddress(candidate)) {
      throw this.unauthorized(
        INVOICE_ERROR_CODES.AUTH_REQUIRED,
        'A registered external wallet bearer address is required.',
      );
    }
    return getAddress(candidate);
  }

  private unauthorized(code: string, message: string) {
    return new UnauthorizedException({ code, message });
  }
}
