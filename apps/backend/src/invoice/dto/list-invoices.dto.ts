import { Transform } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListInvoicesDto {
  @IsOptional()
  @IsEnum(['OPEN', 'VERIFYING', 'PAID', 'EXPIRED', 'CANCELLED'])
  status?: 'OPEN' | 'VERIFYING' | 'PAID' | 'EXPIRED' | 'CANCELLED';

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(0)
  @Max(10_000)
  offset = 0;
}
