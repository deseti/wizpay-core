import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateInvoiceDto {
  @IsEnum(['USDC', 'EURC'])
  token!: 'USDC' | 'EURC';

  @IsString()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/, {
    message: 'amount must be a positive decimal with at most 6 decimal places',
  })
  amount!: string;

  @IsString()
  @MaxLength(120)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  invoiceNumber?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  expiresAt?: string;
}
