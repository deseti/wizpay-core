import { Controller, Post } from '@nestjs/common';
import { TreasuryService } from './treasury.service';

@Controller('treasury')
export class TreasuryController {
  constructor(private readonly treasuryService: TreasuryService) {}

  @Post('init')
  async initTreasury() {
    const result = await this.treasuryService.initializeTreasury();
    return {
      success: true,
      walletSetId: result.walletSetId,
      walletId: result.walletId
    };
  }
}
