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
  type OfficialSwapExecuteResponse,
  type OfficialSwapPlaceholderResponse,
  type OfficialSwapQuoteRequest,
  type OfficialSwapQuoteResponse,
} from './official-swap.types';

@Injectable()
export class OfficialSwapOrchestrator {
  constructor(
    private readonly configService: ConfigService,
    private readonly circleAgentWalletSwapExecutor: CircleAgentWalletSwapExecutor,
  ) {}

  async quote(
    request: OfficialSwapQuoteRequest,
  ): Promise<OfficialSwapQuoteResponse> {
    this.guardEnabled();
    this.guardChain(request.chain);

    const executor = this.getExecutor();
    this.guardTestnetCliEnabled();

    return executor.quote(request);
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

    const executor = this.getExecutor();
    this.guardTestnetCliEnabled();

    return executor.execute(request);
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

  private guardTestnetCliEnabled(): void {
    const testnetCliEnabled =
      this.configService.get<string>('WIZPAY_OFFICIAL_SWAP_ALLOW_TESTNET_CLI') ===
      'true';

    if (!testnetCliEnabled) {
      throw new ServiceUnavailableException({
        code: OFFICIAL_SWAP_ERROR_CODES.TESTNET_CLI_DISABLED,
        message: 'Official swap testnet CLI execution is disabled.',
      });
    }
  }
}
