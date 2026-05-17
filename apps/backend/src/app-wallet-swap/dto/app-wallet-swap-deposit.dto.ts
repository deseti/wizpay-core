import { IsOptional, IsString } from 'class-validator';

export class AppWalletSwapDepositDto {
  @IsOptional()
  @IsString()
  depositTxHash?: string;

  @IsOptional()
  @IsString()
  circleWalletId?: string;

  @IsOptional()
  @IsString()
  circleTransactionId?: string;

  @IsOptional()
  @IsString()
  circleReferenceId?: string;
}
