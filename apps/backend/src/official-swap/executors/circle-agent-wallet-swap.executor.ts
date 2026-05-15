import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  OFFICIAL_SWAP_ALLOWED_CHAIN,
  OFFICIAL_SWAP_ERROR_CODES,
  type OfficialSwapExecuteRequest,
  type OfficialSwapExecuteResponse,
  type OfficialSwapExecutor,
  type OfficialSwapOperation,
  type OfficialSwapQuoteRequest,
  type OfficialSwapQuoteResponse,
} from '../official-swap.types';

const execFileAsync = promisify(execFile);
const CIRCLE_CLI_TIMEOUT_MS = 60_000;

type CommandRunner = (
  file: string,
  args: string[],
  options: { timeout: number },
) => Promise<{ stdout?: unknown; stderr?: unknown }>;

@Injectable()
export class CircleAgentWalletSwapExecutor implements OfficialSwapExecutor {
  private commandRunner: CommandRunner = execFileAsync;

  setCommandRunnerForTest(commandRunner: CommandRunner): void {
    this.commandRunner = commandRunner;
  }

  async quote(
    request: OfficialSwapQuoteRequest,
  ): Promise<OfficialSwapQuoteResponse> {
    await this.guardCircleCliAvailable();

    const stdout = await this.runCircle([
      'wallet',
      'swap',
      request.sellToken,
      request.sellAmount,
      request.buyToken,
      '--chain',
      OFFICIAL_SWAP_ALLOWED_CHAIN,
      '--quote',
      '--output',
      'json',
    ]);
    const data = this.parseDataObject(stdout);

    return {
      status: 'QUOTE_READY',
      sellToken: this.readRequiredString(data, 'sellToken'),
      buyToken: this.readRequiredString(data, 'buyToken'),
      sellAmount: this.readRequiredString(data, 'sellAmount'),
      chain: this.readArcTestnetChain(data),
      estimatedOutput: this.readRequiredString(data, 'estimatedOutput'),
      minOutput: this.readRequiredString(data, 'stopLimit'),
      estimatedOutputRaw: this.readOptionalString(data, 'estimatedOutputRaw'),
      minOutputRaw: this.readOptionalString(data, 'stopLimitRaw'),
      fees: data.fees,
      message: this.readOptionalString(data, 'message'),
    };
  }

  async execute(
    request: OfficialSwapExecuteRequest,
  ): Promise<OfficialSwapExecuteResponse> {
    if (!request.walletAddress?.trim()) {
      throw new BadRequestException({
        code: OFFICIAL_SWAP_ERROR_CODES.WALLET_ADDRESS_REQUIRED,
        message: 'walletAddress is required before official swap execution.',
      });
    }

    await this.guardCircleCliAvailable();

    const stdout = await this.runCircle([
      'wallet',
      'swap',
      request.sellToken,
      request.sellAmount,
      request.buyToken,
      request.minOutput,
      '--address',
      request.walletAddress,
      '--chain',
      OFFICIAL_SWAP_ALLOWED_CHAIN,
      '--output',
      'json',
    ]);
    const data = this.parseDataObject(stdout);
    const operations = this.readOperations(data);

    return {
      operationId: this.readOptionalString(data, 'operationId') ?? randomUUID(),
      status: this.deriveStatus(operations),
      sellToken: this.readRequiredString(data, 'sellToken'),
      buyToken: this.readRequiredString(data, 'buyToken'),
      sellAmount: this.readRequiredString(data, 'sellAmount'),
      minOutput: this.readRequiredString(data, 'buyMin'),
      chain: this.readArcTestnetChain(data),
      txHashes: operations
        .map((operation) => operation.txHash)
        .filter((txHash): txHash is string => typeof txHash === 'string'),
      operations,
      message: this.readOptionalString(data, 'message'),
    };
  }

  private async guardCircleCliAvailable(): Promise<void> {
    try {
      await this.commandRunner('which', ['circle'], {
        timeout: CIRCLE_CLI_TIMEOUT_MS,
      });
    } catch {
      throw new ServiceUnavailableException({
        code: OFFICIAL_SWAP_ERROR_CODES.CIRCLE_CLI_NOT_AVAILABLE,
        message: 'Circle CLI is not available in the backend runtime.',
      });
    }
  }

  private async runCircle(args: string[]): Promise<string> {
    try {
      const result = await this.commandRunner('circle', args, {
        timeout: CIRCLE_CLI_TIMEOUT_MS,
      });

      return this.stringifyStdout(result.stdout);
    } catch {
      throw new BadGatewayException({
        code: OFFICIAL_SWAP_ERROR_CODES.CIRCLE_CLI_EXECUTION_FAILED,
        message: 'Circle CLI swap command failed.',
      });
    }
  }

  private stringifyStdout(stdout: unknown): string {
    if (Buffer.isBuffer(stdout)) {
      return stdout.toString('utf8');
    }

    return typeof stdout === 'string' ? stdout : '';
  }

  private parseDataObject(stdout: string): Record<string, unknown> {
    let parsed: unknown;

    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new BadGatewayException({
        code: OFFICIAL_SWAP_ERROR_CODES.CIRCLE_CLI_INVALID_JSON,
        message: 'Circle CLI returned invalid JSON.',
      });
    }

    if (!this.isRecord(parsed) || !this.isRecord(parsed.data)) {
      throw new BadGatewayException({
        code: OFFICIAL_SWAP_ERROR_CODES.CIRCLE_CLI_UNEXPECTED_RESPONSE,
        message: 'Circle CLI returned an unexpected response shape.',
      });
    }

    return parsed.data;
  }

  private readRequiredString(
    data: Record<string, unknown>,
    field: string,
  ): string {
    const value = data[field];

    if (typeof value !== 'string' || !value.trim()) {
      throw new BadGatewayException({
        code: OFFICIAL_SWAP_ERROR_CODES.CIRCLE_CLI_UNEXPECTED_RESPONSE,
        message: 'Circle CLI returned an unexpected response shape.',
      });
    }

    return value;
  }

  private readOptionalString(
    data: Record<string, unknown>,
    field: string,
  ): string | undefined {
    const value = data[field];

    return typeof value === 'string' ? value : undefined;
  }

  private readArcTestnetChain(data: Record<string, unknown>) {
    const chain = this.readRequiredString(data, 'chain');

    if (chain !== OFFICIAL_SWAP_ALLOWED_CHAIN) {
      throw new BadGatewayException({
        code: OFFICIAL_SWAP_ERROR_CODES.CIRCLE_CLI_UNEXPECTED_RESPONSE,
        message: 'Circle CLI returned an unexpected response shape.',
      });
    }

    return OFFICIAL_SWAP_ALLOWED_CHAIN;
  }

  private readOperations(data: Record<string, unknown>): OfficialSwapOperation[] {
    const transactions = data.transactions;

    if (!Array.isArray(transactions)) {
      throw new BadGatewayException({
        code: OFFICIAL_SWAP_ERROR_CODES.CIRCLE_CLI_UNEXPECTED_RESPONSE,
        message: 'Circle CLI returned an unexpected response shape.',
      });
    }

    return transactions.map((transaction) => {
      if (!this.isRecord(transaction)) {
        throw new BadGatewayException({
          code: OFFICIAL_SWAP_ERROR_CODES.CIRCLE_CLI_UNEXPECTED_RESPONSE,
          message: 'Circle CLI returned an unexpected response shape.',
        });
      }

      return {
        state: this.readOptionalString(transaction, 'state'),
        txHash: this.readOptionalString(transaction, 'txHash'),
        operation: this.readOptionalString(transaction, 'operation'),
        abiFunctionSignature: this.readOptionalString(
          transaction,
          'abiFunctionSignature',
        ),
        contractAddress: this.readOptionalString(
          transaction,
          'contractAddress',
        ),
      };
    });
  }

  private deriveStatus(
    operations: OfficialSwapOperation[],
  ): OfficialSwapExecuteResponse['status'] {
    if (
      operations.length > 0 &&
      operations.every((operation) => operation.state === 'COMPLETE')
    ) {
      return 'COMPLETE';
    }

    if (
      operations.some((operation) =>
        ['FAILED', 'CANCELLED', 'EXPIRED'].includes(operation.state ?? ''),
      )
    ) {
      return 'FAILED';
    }

    return 'IN_PROGRESS';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
