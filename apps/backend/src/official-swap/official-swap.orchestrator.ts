import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OFFICIAL_SWAP_ALLOWED_CHAIN,
  OFFICIAL_SWAP_ERROR_CODES,
  OFFICIAL_SWAP_MAINNET_EXECUTOR,
  type OfficialSwapExecuteRequest,
  type OfficialSwapExecuteResponse,
  type OfficialSwapPlaceholderResponse,
  type OfficialSwapQuoteRequest,
  type OfficialSwapQuoteResponse,
} from './official-swap.types';

@Injectable()
export class OfficialSwapOrchestrator {
  constructor(private readonly configService: ConfigService) {}

  async quote(
    request: OfficialSwapQuoteRequest,
  ): Promise<OfficialSwapQuoteResponse> {
    this.guardEnabled();
    this.guardChain(request.chain);
    this.guardExecutor();
    throw new ServiceUnavailableException({
      code: OFFICIAL_SWAP_ERROR_CODES.QUOTE_FAILED,
      message:
        'Official swap quoting is unavailable from the backend. Quote through the external-wallet Mainnet Uniswap V4 endpoints.',
    });
  }

  async execute(
    request: OfficialSwapExecuteRequest,
  ): Promise<OfficialSwapExecuteResponse> {
    if (!request.minOutput?.trim()) {
      throw new BadRequestException({
        code: OFFICIAL_SWAP_ERROR_CODES.MIN_OUTPUT_REQUIRED,
        message: 'minOutput is required before official swap execution.',
      });
    }

    if (!request.walletAddress?.trim()) {
      throw new BadRequestException({
        code: OFFICIAL_SWAP_ERROR_CODES.WALLET_ADDRESS_REQUIRED,
        message: 'walletAddress is required before official swap execution.',
      });
    }

    this.guardEnabled();
    this.guardChain(request.chain);
    this.guardExecutor();

    throw new ServiceUnavailableException({
      code: OFFICIAL_SWAP_ERROR_CODES.EXECUTION_FAILED,
      message:
        'Official swap execution is unavailable from the backend. Arc Mainnet swaps are signed by the external wallet; the backend does not submit user funds.',
    });
  }

  getStatus(operationId: string): OfficialSwapPlaceholderResponse {
    return {
      operationId,
      status: 'NOT_IMPLEMENTED',
      chain: OFFICIAL_SWAP_ALLOWED_CHAIN,
      message: 'Official swap operation status is not implemented yet.',
    };
  }

  private guardEnabled(): void {
    const enabled =
      this.configService.get<string>('WIZPAY_OFFICIAL_SWAP_ENABLED') === 'true';

    if (!enabled) {
      throw new ServiceUnavailableException({
        code: OFFICIAL_SWAP_ERROR_CODES.DISABLED,
        message: 'Official swap orchestration is disabled.',
      });
    }
  }

  private guardChain(chain: string): void {
    if (chain !== OFFICIAL_SWAP_ALLOWED_CHAIN) {
      throw new BadRequestException({
        code: OFFICIAL_SWAP_ERROR_CODES.UNSUPPORTED_CHAIN,
        message: 'Only ARC-MAINNET is supported by official swap.',
      });
    }
  }

  private guardExecutor(): void {
    const executor =
      this.configService.get<string>('WIZPAY_OFFICIAL_SWAP_EXECUTOR') ??
      'disabled';

    if (executor !== OFFICIAL_SWAP_MAINNET_EXECUTOR) {
      throw new ServiceUnavailableException({
        code: OFFICIAL_SWAP_ERROR_CODES.EXECUTOR_UNAVAILABLE,
        message: 'Official swap executor is unavailable.',
      });
    }
  }
}
