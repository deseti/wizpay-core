import { IsNotEmpty, IsString } from 'class-validator';

export class StablefxFundingPresignDto {
  @IsString()
  @IsNotEmpty()
  contractTradeId!: string;
}
