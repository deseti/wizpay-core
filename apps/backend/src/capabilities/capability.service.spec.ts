import { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { resolveArcCapabilities } from '@wizpay/arc-network';
import { encodeFunctionData } from 'viem';
import { HttpExceptionCompatibilityFilter } from '../common/http-exception.compatibility-filter';
import { CapabilityController } from './capability.controller';
import { CapabilityService } from './capability.service';
import { PaymentRoutingService } from '../routing/payment-routing.service';

const MAINNET_USDC = '0x3600000000000000000000000000000000000000';
const MAINNET_EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
const WIZPAY = '0x1111111111111111111111111111111111111111';

function config(capabilities = resolveArcCapabilities('arc-mainnet', {})) {
  return new ConfigService({
    arcNetwork: {
      key: 'arc-mainnet',
      tokens: {
        USDC: { address: MAINNET_USDC },
        EURC: { address: MAINNET_EURC },
      },
      contracts: { wizpay: { address: WIZPAY } },
    },
    arcCapabilities: capabilities,
  });
}

function capabilityService(value = config()) {
  const routing = new PaymentRoutingService(value);
  return new CapabilityService(value, routing);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function httpServer(app: INestApplication): Server {
  const server: unknown = app.getHttpServer();
  if (typeof server !== 'object' || server === null) {
    throw new Error('HTTP server is unavailable.');
  }
  return server as Server;
}

function responseRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new Error('HTTP body is not an object.');
  return body;
}

describe('CapabilityService (Arc Mainnet only)', () => {
  it('fails closed for unknown access and disabled capabilities', () => {
    const service = capabilityService();
    expect(() => service.assert('Send')).toThrow('Unknown feature capability.');
    expect(() => service.assert('send')).toThrow(
      'This feature is unavailable on the selected Arc network.',
    );
  });

  it('classifies token addresses case-insensitively and cannot route cross-token as same-token', () => {
    const service = capabilityService(
      config({
        ...resolveArcCapabilities('arc-mainnet', {}),
        sameTokenPayroll: true,
      }),
    );
    expect(() =>
      service.assertPayroll({
        sourceTokenAddress: MAINNET_USDC.toUpperCase().replace('0X', '0x'),
        recipients: [{ targetTokenAddress: MAINNET_EURC.toLowerCase() }],
      }),
    ).toThrow(
      'Cross-token payments are unavailable on the selected Arc network.',
    );
    expect(() => service.assertPayroll({ recipients: [{}] })).toThrow(
      'Explicit token context is required for payroll.',
    );
  });

  it('decodes Mainnet payroll calldata so casing and references cannot hide cross-token execution', () => {
    const service = capabilityService(
      config({
        ...resolveArcCapabilities('arc-mainnet', {}),
        sameTokenPayroll: true,
      }),
    );
    const mainnetPayrollAbi = [
      {
        type: 'function',
        name: 'executeCrossTokenPayroll',
        stateMutability: 'payable',
        inputs: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'recipients', type: 'address[]' },
          { name: 'outputAmounts', type: 'uint256[]' },
          { name: 'grossInput', type: 'uint256' },
          { name: 'minTotalOut', type: 'uint256' },
          { name: 'minHopPriceX36', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
          { name: 'referenceId', type: 'string' },
        ],
        outputs: [{ name: 'amountOut', type: 'uint256' }],
      },
    ] as const;
    const callData = encodeFunctionData({
      abi: mainnetPayrollAbi,
      functionName: 'executeCrossTokenPayroll',
      args: [
        MAINNET_USDC,
        MAINNET_EURC.toLowerCase() as `0x${string}`,
        ['0x2222222222222222222222222222222222222222'],
        [1n],
        2n,
        1n,
        1n,
        2_000_000_300n,
        'reference',
      ],
    });
    expect(() =>
      (service as unknown as Record<string, (params: unknown) => void>)
        .assertPayrollCall({
        contractAddress: WIZPAY.toUpperCase().replace('0X', '0x'),
        callData,
      }),
    ).toThrow(
      'Cross-token payments are unavailable on the selected Arc network.',
    );
  });

  it('preserves validated Mainnet payroll approval challenges', () => {
    const service = capabilityService(
      config({
        ...resolveArcCapabilities('arc-mainnet', {}),
        sameTokenPayroll: true,
      }),
    );
    const approveAbi = [
      {
        type: 'function',
        name: 'approve',
        stateMutability: 'nonpayable',
        inputs: [
          { name: 'spender', type: 'address' },
          { name: 'amount', type: 'uint256' },
        ],
        outputs: [{ name: '', type: 'bool' }],
      },
    ] as const;
    const approval = (spender: `0x${string}`) =>
      encodeFunctionData({
        abi: approveAbi,
        functionName: 'approve',
        args: [spender, 1n],
      });

    expect(() =>
      (service as unknown as Record<string, (params: unknown) => void>)
        .assertPayrollApproval({
        contractAddress: MAINNET_USDC,
        callData: approval(WIZPAY),
      }),
    ).not.toThrow();
    expect(() =>
      (service as unknown as Record<string, (params: unknown) => void>)
        .assertPayrollApproval({
        contractAddress: MAINNET_USDC,
        callData: approval('0x3333333333333333333333333333333333333333'),
      }),
    ).toThrow('Explicit token context is required for payroll approval.');
  });
});

describe('capability HTTP boundary', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CapabilityController],
      providers: [
        CapabilityService,
        PaymentRoutingService,
        { provide: ConfigService, useValue: config() },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalFilters(new HttpExceptionCompatibilityFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  it('returns only the selected network and effective booleans', async () => {
    const response = await request(httpServer(app))
      .get('/capabilities')
      .expect(200);
    const payload = responseRecord(response.body).data;
    if (!isRecord(payload) || !isRecord(payload.capabilities)) {
      throw new Error('Capability payload is malformed.');
    }
    expect(payload.network).toBe('arc-mainnet');
    expect(
      Object.values(payload.capabilities).every((value) => value === false),
    ).toBe(true);
    expect(JSON.stringify(response.body)).not.toMatch(
      /secret|environment|WIZPAY_/i,
    );
  });
});
