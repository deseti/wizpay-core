import { IsNotEmpty, IsString } from 'class-validator';

export class OfficialSwapQuoteDto {
  @IsString()
  @IsNotEmpty()
  sellToken!: string;

  @IsString()
  @IsNotEmpty()
  buyToken!: string;

  @IsString()
  @IsNotEmpty()
  sellAmount!: string;

  @IsString()
  @IsNotEmpty()
  chain!: string;
}
