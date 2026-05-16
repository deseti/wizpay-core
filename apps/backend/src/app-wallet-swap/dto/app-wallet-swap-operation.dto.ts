import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { AppWalletSwapQuoteDto } from './app-wallet-swap-quote.dto';

export class AppWalletSwapOperationDto extends AppWalletSwapQuoteDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  quoteId?: string;
}
