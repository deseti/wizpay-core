import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CircleAgentWalletSwapExecutor } from './executors/circle-agent-wallet-swap.executor';
import {
  OFFICIAL_SWAP_ALLOWED_CHAIN,
  OFFICIAL_SWAP_CIRCLE_AGENT_WALLET_EXECUTOR,
  OFFICIAL_SWAP_ERROR_CODES,
  type OfficialSwapExecuteRequest,
  type OfficialSwapPlaceholderResponse,
  type OfficialSwapQuoteRequest,
} from './official-swap.types';

@Injectable()
export class OfficialSwapOrchestrator {
  constructor(
    private readonly configService: ConfigService,
    private readonly circleAgentWalletSwapExecutor: CircleAgentWalletSwapExecutor,
  ) {}

  async quote(
    request: OfficialSwapQuoteRequest,
  ): Promise<OfficialSwapPlaceholderResponse> {
    this.guardEnabled();
    this.guardChain(request.chain);

    return this.getExecutor().quote(request);
  }

  async execute(
    request: OfficialSwapExecuteRequest,
  ): Promise<OfficialSwapPlaceholderResponse> {
    if (!request.minOutput?.trim()) {
      throw new BadRequestException({
        code: OFFICIAL_SWAP_ERROR_CODES.MIN_OUTPUT_REQUIRED,
        message: 'minOutput is required before official swap execution.',
      });
    }

    this.guardEnabled();
    this.guardChain(request.chain);

    return this.getExecutor().execute(request);
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
        message: 'Only ARC-TESTNET is supported by this official swap scaffold.',
      });
    }
  }

  private getExecutor(): CircleAgentWalletSwapExecutor {
    const executor =
      this.configService.get<string>('WIZPAY_OFFICIAL_SWAP_EXECUTOR') ??
      'disabled';

    if (executor !== OFFICIAL_SWAP_CIRCLE_AGENT_WALLET_EXECUTOR) {
      throw new ServiceUnavailableException({
        code: OFFICIAL_SWAP_ERROR_CODES.EXECUTOR_UNAVAILABLE,
        message: 'Official swap executor is unavailable.',
      });
    }

    return this.circleAgentWalletSwapExecutor;
  }
}
