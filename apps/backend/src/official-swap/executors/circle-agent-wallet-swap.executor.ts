import { Injectable, NotImplementedException } from '@nestjs/common';
import {
  OFFICIAL_SWAP_ALLOWED_CHAIN,
  OFFICIAL_SWAP_ERROR_CODES,
  type OfficialSwapExecuteRequest,
  type OfficialSwapExecutor,
  type OfficialSwapPlaceholderResponse,
  type OfficialSwapQuoteRequest,
} from '../official-swap.types';

@Injectable()
export class CircleAgentWalletSwapExecutor implements OfficialSwapExecutor {
  async quote(
    _request: OfficialSwapQuoteRequest,
  ): Promise<OfficialSwapPlaceholderResponse> {
    throw this.notImplemented('Official swap quoting is not implemented yet.');
  }

  async execute(
    _request: OfficialSwapExecuteRequest,
  ): Promise<OfficialSwapPlaceholderResponse> {
    throw this.notImplemented('Official swap execution is not implemented yet.');
  }

  private notImplemented(message: string): NotImplementedException {
    return new NotImplementedException({
      code: OFFICIAL_SWAP_ERROR_CODES.NOT_IMPLEMENTED,
      message,
      status: 'NOT_IMPLEMENTED',
      chain: OFFICIAL_SWAP_ALLOWED_CHAIN,
    });
  }
}
