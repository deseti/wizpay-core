import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export class AppWalletXylonetChallengeResultDto {
  @IsString()
  @IsIn([
    'PENDING',
    'IN_PROGRESS',
    'INITIATED',
    'SUBMITTED',
    'COMPLETE',
    'COMPLETED',
    'SUCCESS',
    'SUCCEEDED',
    'FAILED',
    'CANCELLED',
    'CANCELED',
    'REJECTED',
    'DENIED',
    'EXPIRED',
    'TIMED_OUT',
  ])
  status!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
