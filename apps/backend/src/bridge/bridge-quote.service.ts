import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CCTP_PRODUCTION,
  getBridgeChain,
  getBridgeFinalityThreshold,
  getBridgeTransferMode,
} from '@wizpay/bridge-registry';

export type BridgeTransferMode = 'fast' | 'standard';

export type BridgeQuote = Readonly<{
  sourceCode: string;
  destinationCode: string;
  transferMode: BridgeTransferMode;
  minFinalityThreshold: 1000 | 2000;
  amount: string;
  protocolFee: string;
  maxFeeSuggested: string;
  receiveAmount: string;
  allowanceSufficient: boolean | null;
}>;

export function parseCircleMinimumFeeBps(
  feesJson: unknown,
  sourceDomain: number,
  destinationDomain: number,
): number {
  const list = Array.isArray(feesJson)
    ? feesJson
    : Array.isArray((feesJson as Record<string, unknown>)?.['fees'])
      ? ((feesJson as Record<string, unknown>)['fees'] as unknown[])
      : null;
  if (!list) {
    throw new Error('Circle fee response is malformed.');
  }
  const candidates = list.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === 'object',
  );
  const fastEntry =
    candidates.find(
      (entry) =>
        Number(entry['sourceDomain'] ?? entry['source_domain']) ===
          sourceDomain &&
        Number(entry['destinationDomain'] ?? entry['destination_domain']) ===
          destinationDomain &&
        Number(entry['finalityThreshold'] ?? entry['finality_threshold']) ===
          CCTP_PRODUCTION.fastFinalityThreshold,
    ) ??
    candidates.find(
      (entry) =>
        Number(entry['finalityThreshold'] ?? entry['finality_threshold']) ===
        CCTP_PRODUCTION.fastFinalityThreshold,
    );
  if (!fastEntry) {
    throw new Error('Circle Fast fee is unavailable for this route.');
  }
  const raw =
    fastEntry['minimumFee'] ?? fastEntry['minimum_fee'] ?? fastEntry['fee'];
  const bps = typeof raw === 'string' ? Number(raw) : Number(raw);
  if (!Number.isFinite(bps) || bps < 0 || bps > 100) {
    throw new Error('Circle Fast fee is malformed.');
  }
  return bps;
}

export function calculateFastProtocolFee(
  amountUnits: bigint,
  feeBps: number,
): bigint {
  if (amountUnits <= 0n) return 0n;
  const hundredths = Math.round(feeBps * 100);
  if (!Number.isSafeInteger(hundredths) || hundredths < 0) {
    throw new Error('Circle Fast fee is malformed.');
  }
  if (hundredths === 0) return 0n;
  // Ceil so tiny amounts never quote a zero fee that Circle rejects with
  // insufficient_fee (e.g. 5000 units at 0.325bps = 0.1625 -> 1, not 0).
  return (amountUnits * BigInt(hundredths) + 999_999n) / 1_000_000n;
}

export function calculateFastMaxFee(protocolFee: bigint): bigint {
  if (protocolFee <= 0n) return 0n;
  // Ceil the 20% buffer for the same reason.
  return (protocolFee * 120n + 99n) / 100n;
}

export function parseFastAllowanceSubunits(value: unknown): bigint {
  const text = String(value ?? '');
  if (!/^\d+(?:\.\d{1,6})?$/.test(text.trim())) {
    throw new Error('Circle Fast allowance is malformed.');
  }
  const [whole, frac = ''] = text.trim().split('.');
  return BigInt(whole) * 1_000_000n + BigInt((frac + '000000').slice(0, 6));
}

@Injectable()
export class BridgeQuoteService {
  constructor(private readonly config: ConfigService) {}

  async quote(
    sourceCode: string,
    destinationCode: string,
    amount: string,
  ): Promise<BridgeQuote> {
    const source = getBridgeChain(sourceCode);
    const destination = getBridgeChain(destinationCode);
    if (!/^(0|[1-9][0-9]*)$/.test(amount)) {
      throw new ServiceUnavailableException({
        code: 'BRIDGE_QUOTE_UNAVAILABLE',
        message: 'Bridge quote amount is invalid.',
      });
    }
    const amountUnits = BigInt(amount);
    if (amountUnits <= 0n) {
      throw new ServiceUnavailableException({
        code: 'BRIDGE_QUOTE_UNAVAILABLE',
        message: 'Bridge quote amount is invalid.',
      });
    }
    const mode = getBridgeTransferMode(source.code);
    const threshold = getBridgeFinalityThreshold(source.code);
    if (mode === 'standard') {
      return Object.freeze({
        sourceCode: source.code,
        destinationCode: destination.code,
        transferMode: mode,
        minFinalityThreshold: threshold,
        amount: amountUnits.toString(),
        protocolFee: '0',
        maxFeeSuggested: '0',
        receiveAmount: amountUnits.toString(),
        allowanceSufficient: null,
      });
    }
    const feeBps = await this.fastFeeBps(source.domain, destination.domain);
    const protocolFee = calculateFastProtocolFee(amountUnits, feeBps);
    const maxFeeSuggested = calculateFastMaxFee(protocolFee);
    if (maxFeeSuggested > amountUnits) {
      throw new ServiceUnavailableException({
        code: 'BRIDGE_FAST_UNAVAILABLE',
        message: 'Fast CCTP transfer is temporarily unavailable for this route.',
      });
    }
    const allowance = await this.fastAllowanceSubunits();
    if (allowance < amountUnits) {
      throw new ServiceUnavailableException({
        code: 'BRIDGE_FAST_UNAVAILABLE',
        message: 'Fast CCTP transfer is temporarily unavailable for this route.',
      });
    }
    return Object.freeze({
      sourceCode: source.code,
      destinationCode: destination.code,
      transferMode: mode,
      minFinalityThreshold: threshold,
      amount: amountUnits.toString(),
      protocolFee: protocolFee.toString(),
      maxFeeSuggested: maxFeeSuggested.toString(),
      receiveAmount: (amountUnits - protocolFee).toString(),
      allowanceSufficient: true,
    });
  }

  async fastFeeBps(sourceDomain: number, destinationDomain: number) {
    const base = this.irisBase();
    let response: Response;
    try {
      response = await fetch(
        `${base}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}`,
        { signal: AbortSignal.timeout(15_000) },
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'BRIDGE_FAST_UNAVAILABLE',
        message: 'Fast CCTP transfer is temporarily unavailable for this route.',
      });
    }
    if (!response.ok) {
      throw new ServiceUnavailableException({
        code: 'BRIDGE_FAST_UNAVAILABLE',
        message: 'Fast CCTP transfer is temporarily unavailable for this route.',
      });
    }
    try {
      return parseCircleMinimumFeeBps(
        await response.json(),
        sourceDomain,
        destinationDomain,
      );
    } catch {
      throw new ServiceUnavailableException({
        code: 'BRIDGE_FAST_UNAVAILABLE',
        message: 'Fast CCTP transfer is temporarily unavailable for this route.',
      });
    }
  }

  async fastAllowanceSubunits(): Promise<bigint> {
    const base = this.irisBase();
    let response: Response;
    try {
      response = await fetch(`${base}/v2/fastBurn/USDC/allowance`, {
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ServiceUnavailableException({
        code: 'BRIDGE_FAST_UNAVAILABLE',
        message: 'Fast CCTP transfer is temporarily unavailable for this route.',
      });
    }
    if (!response.ok) {
      throw new ServiceUnavailableException({
        code: 'BRIDGE_FAST_UNAVAILABLE',
        message: 'Fast CCTP transfer is temporarily unavailable for this route.',
      });
    }
    try {
      const body = (await response.json()) as { allowance?: unknown };
      return parseFastAllowanceSubunits(body.allowance);
    } catch {
      throw new ServiceUnavailableException({
        code: 'BRIDGE_FAST_UNAVAILABLE',
        message: 'Fast CCTP transfer is temporarily unavailable for this route.',
      });
    }
  }

  private irisBase(): string {
    return (
      this.config.get<string>('CCTP_IRIS_API_BASE_URL') ??
      CCTP_PRODUCTION.irisApiBaseUrl
    ).replace(/\/$/, '');
  }
}
