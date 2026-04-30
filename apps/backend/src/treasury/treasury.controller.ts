import { Controller, Post, Get, Query } from '@nestjs/common';
import { TreasuryService } from './treasury.service';

@Controller('treasury')
export class TreasuryController {
  constructor(private readonly treasuryService: TreasuryService) {}

  @Post('init')
  async initTreasury() {
    const result = await this.treasuryService.initializeTreasury();
    return {
      data: {
        success: true,
        walletSetId: result.walletSetId,
        walletId: result.walletId
      }
    };
  }

  @Get('wallet')
  async getTreasuryWallet(@Query('blockchain') blockchain: string) {
    const wallet = await this.treasuryService.getTreasuryWallet(blockchain);
    return {
      data: wallet
    };
  }
}

