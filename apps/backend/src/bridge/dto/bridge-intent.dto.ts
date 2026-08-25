import {
  IsEthereumAddress,
  IsInt,
  IsNotEmpty,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';

const UINT_STRING = /^(0|[1-9][0-9]*)$/;
const TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/;

export class CreateBridgeIntentDto {
  @IsUUID()
  idempotencyKey!: string;

  @IsString()
  @IsNotEmpty()
  sourceCode!: string;

  @IsString()
  @IsNotEmpty()
  destinationCode!: string;

  @IsEthereumAddress()
  walletAddress!: string;

  @IsEthereumAddress()
  recipientAddress!: string;

  @Matches(UINT_STRING)
  amount!: string;

  @Matches(UINT_STRING)
  maxFee!: string;

  @IsInt()
  @Min(2_000)
  @Max(2_000)
  minFinalityThreshold!: number;
}

export class BridgeWalletDto {
  @IsEthereumAddress()
  walletAddress!: string;
}

export class ReportBridgeApprovalDto extends BridgeWalletDto {
  @Matches(TRANSACTION_HASH)
  transactionHash!: string;
}

export class ReportBridgeSourceDto extends BridgeWalletDto {
  @Matches(TRANSACTION_HASH)
  transactionHash!: string;
}

export class ReportBridgeDestinationDto extends BridgeWalletDto {
  @Matches(TRANSACTION_HASH)
  transactionHash!: string;

  @Matches(/^0x[0-9a-fA-F]{64}$/)
  messageHash!: string;
}

export class AuthorizeBridgeDestinationDto extends BridgeWalletDto {}

export class SubmitBridgeDestinationDto extends ReportBridgeDestinationDto {
  @IsUUID()
  leaseId!: string;
}
