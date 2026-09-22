import { Injectable } from '@nestjs/common';
import { WalletAuthService } from '../modules/wallet/wallet-auth.service';
import type { InvoiceMerchantPrincipal } from './invoice.types';

export type AuthenticatedWalletPrincipal = InvoiceMerchantPrincipal;

@Injectable()
export class InvoiceAuthService {
  constructor(private readonly walletAuth: WalletAuthService) {}

  /**
   * Account-scoped invoice and activity access uses the opaque session issued
   * only after an Arc Mainnet wallet signs a one-time message challenge.
   */
  async authenticate(
    authorization?: string,
  ): Promise<InvoiceMerchantPrincipal> {
    return this.walletAuth.authenticate(authorization);
  }
}
