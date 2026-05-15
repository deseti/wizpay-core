import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CircleAgentWalletSwapExecutor } from './circle-agent-wallet-swap.executor';

describe('CircleAgentWalletSwapExecutor', () => {
  const walletAddress = '0x90ab859240b941eaf0cbcbf42df5086e0ad54147';
  const quoteJson = JSON.stringify({
    data: {
      message: 'Quote: 1 USDC -> ~0.960322 EURC (min 0.000001) on ARC-TESTNET',
      sellToken: 'USDC',
      sellAmount: '1',
      buyToken: 'EURC',
      chain: 'ARC-TESTNET',
      estimatedOutput: '0.960322',
      stopLimit: '0.000001',
      estimatedOutputRaw: '960322',
      stopLimitRaw: '1',
      fees: {
        swap: [],
        provider: [
          {
            token: '0x3600000000000000000000000000000000000000',
            amount: '200',
          },
        ],
      },
    },
  });
  const executeJson = JSON.stringify({
    data: {
      message: 'Swap complete: 1 USDC -> min 0.90 EURC on ARC-TESTNET',
      sellToken: 'USDC',
      sellAmount: '1',
      buyToken: 'EURC',
      buyMin: '0.90',
      chain: 'ARC-TESTNET',
      transactions: [
        {
          state: 'COMPLETE',
          txHash:
            '0xd1bb06e0613243e77fc931a3c421d4c33620ae2da865b5dc42b842e78790a3e0',
          operation: 'CONTRACT_EXECUTION',
          abiFunctionSignature: 'approve(address,uint256)',
          contractAddress: '0x3600000000000000000000000000000000000000',
        },
        {
          state: 'COMPLETE',
          txHash:
            '0x02c6c48bb88458bf229f6e5057b69bb8f705a1970887ac57fc716df7f339cdb7',
          operation: 'CONTRACT_EXECUTION',
          contractAddress: '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b',
        },
      ],
    },
  });

  function createSubject(commandRunner = jest.fn()) {
    const executor = new CircleAgentWalletSwapExecutor();
    executor.setCommandRunnerForTest(commandRunner);

    return { executor, commandRunner };
  }

  it('builds quote execFile args and parses observed quote JSON', async () => {
    const { executor, commandRunner } = createSubject(
      jest
        .fn()
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/circle\n' })
        .mockResolvedValueOnce({ stdout: quoteJson }),
    );

    await expect(
      executor.quote({
        sellToken: 'USDC',
        sellAmount: '1',
        buyToken: 'EURC',
        chain: 'ARC-TESTNET',
      }),
    ).resolves.toEqual({
      status: 'QUOTE_READY',
      sellToken: 'USDC',
      buyToken: 'EURC',
      sellAmount: '1',
      chain: 'ARC-TESTNET',
      estimatedOutput: '0.960322',
      minOutput: '0.000001',
      estimatedOutputRaw: '960322',
      minOutputRaw: '1',
      fees: {
        swap: [],
        provider: [
          {
            token: '0x3600000000000000000000000000000000000000',
            amount: '200',
          },
        ],
      },
      message: 'Quote: 1 USDC -> ~0.960322 EURC (min 0.000001) on ARC-TESTNET',
    });
    expect(commandRunner).toHaveBeenNthCalledWith(1, 'which', ['circle'], {
      timeout: 60000,
    });
    expect(commandRunner).toHaveBeenNthCalledWith(
      2,
      'circle',
      [
        'wallet',
        'swap',
        'USDC',
        '1',
        'EURC',
        '--chain',
        'ARC-TESTNET',
        '--quote',
        '--output',
        'json',
      ],
      { timeout: 60000 },
    );
  });

  it('builds execute execFile args and parses observed execute JSON', async () => {
    const { executor, commandRunner } = createSubject(
      jest
        .fn()
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/circle\n' })
        .mockResolvedValueOnce({ stdout: executeJson }),
    );

    const response = await executor.execute({
      sellToken: 'USDC',
      sellAmount: '1',
      buyToken: 'EURC',
      minOutput: '0.90',
      chain: 'ARC-TESTNET',
      walletAddress,
    });

    expect(response).toMatchObject({
      status: 'COMPLETE',
      sellToken: 'USDC',
      buyToken: 'EURC',
      sellAmount: '1',
      minOutput: '0.90',
      chain: 'ARC-TESTNET',
      txHashes: [
        '0xd1bb06e0613243e77fc931a3c421d4c33620ae2da865b5dc42b842e78790a3e0',
        '0x02c6c48bb88458bf229f6e5057b69bb8f705a1970887ac57fc716df7f339cdb7',
      ],
      operations: [
        {
          state: 'COMPLETE',
          txHash:
            '0xd1bb06e0613243e77fc931a3c421d4c33620ae2da865b5dc42b842e78790a3e0',
          operation: 'CONTRACT_EXECUTION',
          abiFunctionSignature: 'approve(address,uint256)',
          contractAddress: '0x3600000000000000000000000000000000000000',
        },
        {
          state: 'COMPLETE',
          txHash:
            '0x02c6c48bb88458bf229f6e5057b69bb8f705a1970887ac57fc716df7f339cdb7',
          operation: 'CONTRACT_EXECUTION',
          contractAddress: '0xbbd70b01a1cabc96d5b7b129ae1aaabdf50dd40b',
        },
      ],
      message: 'Swap complete: 1 USDC -> min 0.90 EURC on ARC-TESTNET',
    });
    expect(response.operationId).toEqual(expect.any(String));
    expect(commandRunner).toHaveBeenNthCalledWith(
      2,
      'circle',
      [
        'wallet',
        'swap',
        'USDC',
        '1',
        'EURC',
        '0.90',
        '--address',
        walletAddress,
        '--chain',
        'ARC-TESTNET',
        '--output',
        'json',
      ],
      { timeout: 60000 },
    );
  });

  it('requires walletAddress for execute', async () => {
    const { executor, commandRunner } = createSubject();

    await expect(
      executor.execute({
        sellToken: 'USDC',
        sellAmount: '1',
        buyToken: 'EURC',
        minOutput: '0.90',
        chain: 'ARC-TESTNET',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'WALLET_ADDRESS_REQUIRED',
      },
    });
    await expect(
      executor.execute({
        sellToken: 'USDC',
        sellAmount: '1',
        buyToken: 'EURC',
        minOutput: '0.90',
        chain: 'ARC-TESTNET',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('maps missing Circle CLI to CIRCLE_CLI_NOT_AVAILABLE', async () => {
    const { executor } = createSubject(
      jest.fn().mockRejectedValueOnce(new Error('missing')),
    );

    const promise = executor.quote({
      sellToken: 'USDC',
      sellAmount: '1',
      buyToken: 'EURC',
      chain: 'ARC-TESTNET',
    });

    await expect(promise).rejects.toMatchObject({
      response: {
        code: 'CIRCLE_CLI_NOT_AVAILABLE',
      },
    });
    await expect(promise).rejects.toThrow(ServiceUnavailableException);
  });

  it('maps CLI failure to CIRCLE_CLI_EXECUTION_FAILED', async () => {
    const { executor } = createSubject(
      jest
        .fn()
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/circle\n' })
        .mockRejectedValueOnce(new Error('exit 1')),
    );

    const promise = executor.quote({
      sellToken: 'USDC',
      sellAmount: '1',
      buyToken: 'EURC',
      chain: 'ARC-TESTNET',
    });

    await expect(promise).rejects.toMatchObject({
      response: {
        code: 'CIRCLE_CLI_EXECUTION_FAILED',
      },
    });
    await expect(promise).rejects.toThrow(BadGatewayException);
  });

  it('maps invalid JSON to CIRCLE_CLI_INVALID_JSON', async () => {
    const { executor } = createSubject(
      jest
        .fn()
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/circle\n' })
        .mockResolvedValueOnce({ stdout: 'not-json' }),
    );

    await expect(
      executor.quote({
        sellToken: 'USDC',
        sellAmount: '1',
        buyToken: 'EURC',
        chain: 'ARC-TESTNET',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'CIRCLE_CLI_INVALID_JSON',
      },
    });
  });

  it('maps missing data object to CIRCLE_CLI_UNEXPECTED_RESPONSE', async () => {
    const { executor } = createSubject(
      jest
        .fn()
        .mockResolvedValueOnce({ stdout: '/usr/local/bin/circle\n' })
        .mockResolvedValueOnce({ stdout: JSON.stringify({ ok: true }) }),
    );

    await expect(
      executor.quote({
        sellToken: 'USDC',
        sellAmount: '1',
        buyToken: 'EURC',
        chain: 'ARC-TESTNET',
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'CIRCLE_CLI_UNEXPECTED_RESPONSE',
      },
    });
  });

  it('keeps official-swap free of legacy FX imports', () => {
    const officialSwapDir = path.resolve(__dirname, '..');
    const files = collectTsFiles(officialSwapDir).filter(
      (file) => !file.endsWith('.spec.ts'),
    );
    const forbiddenAdapters = new RegExp(
      ['StableFXAdapter', 'StableFXRfqClient'].join('|'),
    );
    const forbiddenRoutes = new RegExp(
      ['tasks/fx', 'tasks/swap/init'].join('|'),
    );

    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(forbiddenAdapters);
      expect(source).not.toMatch(forbiddenRoutes);
    }
  });
});

function collectTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      return collectTsFiles(fullPath);
    }

    return entry.isFile() && fullPath.endsWith('.ts') ? [fullPath] : [];
  });
}
