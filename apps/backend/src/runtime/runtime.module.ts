import { DynamicModule, Global, Module } from '@nestjs/common';

export type WizPayRuntimeMode = 'server' | 'serverless';
export const WIZPAY_RUNTIME_MODE = Symbol('WIZPAY_RUNTIME_MODE');

export function resolveRuntimeMode(
  value: unknown,
  fallback: WizPayRuntimeMode = 'server',
): WizPayRuntimeMode {
  if (value === undefined) return fallback;
  if (value === 'server' || value === 'serverless') return value;
  throw new Error('WIZPAY_RUNTIME_MODE must be server or serverless.');
}

@Global()
@Module({})
export class RuntimeModule {
  static forRoot(mode: WizPayRuntimeMode): DynamicModule {
    return {
      module: RuntimeModule,
      providers: [
        { provide: WIZPAY_RUNTIME_MODE, useValue: resolveRuntimeMode(mode) },
      ],
      exports: [WIZPAY_RUNTIME_MODE],
    };
  }
}
