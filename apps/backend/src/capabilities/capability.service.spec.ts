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
import { W3sAuthController } from '../modules/wallet/w3s-auth.controller';
import { W3sAuthService } from '../modules/wallet/w3s-auth.service';
import { PaymentRoutingService } from '../routing/payment-routing.service';

const TESTNET_USDC = '0x3600000000000000000000000000000000000000';
const TESTNET_EURC = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';
const WIZPAY = '0x1111111111111111111111111111111111111111';
const PAYROLL_ABI = [
  {
    type: 'function',
    name: 'batchRouteAndPay',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'tokenIn', type: 'address' },
      { name: 'tokenOuts', type: 'address[]' },
      { name: 'recipients', type: 'address[]' },
      { name: 'amountsIn', type: 'uint256[]' },
      { name: 'minAmountsOut', type: 'uint256[]' },
      { name: 'referenceId', type: 'string' },
    ],
    outputs: [{ name: 'totalOut', type: 'uint256' }],
  },
] as const;

function config(capabilities = resolveArcCapabilities('arc-mainnet', {})) {
  return new ConfigService({
    arcNetwork: {
      key: 'arc-mainnet',
      tokens: {
        USDC: { address: TESTNET_USDC },
        EURC: { address: TESTNET_EURC },
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

describe('CapabilityService', () => {
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
        sourceTokenAddress: TESTNET_USDC.toUpperCase().replace('0X', '0x'),
        recipients: [{ targetTokenAddress: TESTNET_EURC.toLowerCase() }],
      }),
    ).toThrow(
      'Cross-token payments are unavailable on the selected Arc network.',
    );
    expect(() => service.assertPayroll({ recipients: [{}] })).toThrow(
      'Explicit token context is required for payroll.',
    );
  });

  it('guards generic challenge creation by stable operation context', () => {
    const service = capabilityService();
    expect(() =>
      service.assertW3sAction('createContractExecutionChallenge', {
        refId: 'INV-operation',
        contractAddress: TESTNET_USDC,
        callData: `0xa9059cbb${'0'.repeat(128)}`,
      }),
    ).toThrow('This feature is unavailable on the selected Arc network.');
    expect(() =>
      service.assertW3sAction('createContractExecutionChallenge', {
        refId: 'unclassified',
      }),
    ).toThrow('Explicit token context is required for contract execution.');
  });

  it('decodes payroll challenge calldata so casing and references cannot hide cross-token execution', () => {
    const service = capabilityService(
      config({
        ...resolveArcCapabilities('arc-mainnet', {}),
        sameTokenPayroll: true,
      }),
    );
    const callData = encodeFunctionData({
      abi: PAYROLL_ABI,
      functionName: 'batchRouteAndPay',
      args: [
        TESTNET_USDC,
        [TESTNET_EURC.toLowerCase() as `0x${string}`],
        ['0x2222222222222222222222222222222222222222'],
        [1n],
        [1n],
        'reference',
      ],
    });
    expect(() =>
      service.assertW3sAction('createContractExecutionChallenge', {
        refId: 'PAYROLL-spoofed',
        contractAddress: WIZPAY.toUpperCase().replace('0X', '0x'),
        callData,
      }),
    ).toThrow(
      'Cross-token payments are unavailable on the selected Arc network.',
    );
  });

  it('preserves validated Testnet payroll approval challenges', () => {
    const value = new ConfigService({
      arcNetwork: {
        key: 'arc-testnet',
        tokens: {
          USDC: { address: TESTNET_USDC },
          EURC: { address: TESTNET_EURC },
        },
        contracts: { wizpay: { address: WIZPAY } },
      },
      arcCapabilities: resolveArcCapabilities('arc-testnet', {}),
    });
    const service = capabilityService(value);
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
      service.assertW3sAction('createContractExecutionChallenge', {
        refId: 'PAYROLL-APPROVE-test',
        contractAddress: TESTNET_USDC,
        callData: approval(WIZPAY),
      }),
    ).not.toThrow();
    expect(() =>
      service.assertW3sAction('createContractExecutionChallenge', {
        refId: 'PAYROLL-APPROVE-spoofed',
        contractAddress: TESTNET_USDC,
        callData: approval('0x3333333333333333333333333333333333333333'),
      }),
    ).toThrow('Explicit token context is required for payroll approval.');
  });
});

describe('capability HTTP boundary', () => {
  let app: INestApplication;
  const dispatch = jest.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [CapabilityController, W3sAuthController],
      providers: [
        CapabilityService,
        PaymentRoutingService,
        { provide: ConfigService, useValue: config() },
        { provide: W3sAuthService, useValue: { dispatch } },
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

  it('rejects disabled challenge requests before Circle dispatch', async () => {
    const response = await request(httpServer(app))
      .post('/w3s/action')
      .send({
        action: 'createTransferChallenge',
        refId: 'SEND-test',
        tokenAddress: TESTNET_USDC,
      })
      .expect(503);
    expect(responseRecord(response.body).code).toBe('CAPABILITY_DISABLED');
    expect(dispatch).not.toHaveBeenCalled();
  });
});
