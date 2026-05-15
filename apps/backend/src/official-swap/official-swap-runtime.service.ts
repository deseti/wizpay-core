import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  OFFICIAL_SWAP_ALLOWED_CHAIN,
  OFFICIAL_SWAP_CIRCLE_AGENT_WALLET_EXECUTOR,
  type OfficialSwapExecutorConfigured,
} from './official-swap.types';

const execFileAsync = promisify(execFile);

type CommandRunner = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<unknown>;

export interface OfficialSwapRuntimeStatus {
  circleCliAvailable: boolean;
  executorConfigured: OfficialSwapExecutorConfigured;
  enabled: boolean;
  chain: typeof OFFICIAL_SWAP_ALLOWED_CHAIN;
}

@Injectable()
export class OfficialSwapRuntimeService {
  private commandRunner: CommandRunner = execFileAsync;

  constructor(private readonly configService: ConfigService) {}

  setCommandRunnerForTest(commandRunner: CommandRunner): void {
    this.commandRunner = commandRunner;
  }

  async getRuntimeStatus(): Promise<OfficialSwapRuntimeStatus> {
    return {
      circleCliAvailable: await this.isCircleCliAvailable(),
      executorConfigured: this.getExecutorConfigured(),
      enabled:
        this.configService.get<string>('WIZPAY_OFFICIAL_SWAP_ENABLED') ===
        'true',
      chain: OFFICIAL_SWAP_ALLOWED_CHAIN,
    };
  }

  private getExecutorConfigured(): OfficialSwapExecutorConfigured {
    const executor = this.configService.get<string>(
      'WIZPAY_OFFICIAL_SWAP_EXECUTOR',
    );

    if (!executor?.trim()) {
      return 'disabled';
    }

    if (executor === OFFICIAL_SWAP_CIRCLE_AGENT_WALLET_EXECUTOR) {
      return OFFICIAL_SWAP_CIRCLE_AGENT_WALLET_EXECUTOR;
    }

    return 'unsupported';
  }

  private async isCircleCliAvailable(): Promise<boolean> {
    try {
      await this.commandRunner('which', ['circle'], { timeout: 2000 });
      return true;
    } catch {
      return false;
    }
  }
}
