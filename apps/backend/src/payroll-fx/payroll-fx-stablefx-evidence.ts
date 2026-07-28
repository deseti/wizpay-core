export class PayrollFxStablefxEvidenceReader {
  getTypedData(raw: unknown): Record<string, unknown> | null {
    const typedData = this.getNestedValue(raw, ['typedData']);
    return this.isRecord(typedData) ? typedData : null;
  }

  getString(raw: unknown, path: string[]): string | null {
    const value = this.getNestedValue(raw, path);
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'bigint') {
      return String(value);
    }
    return null;
  }

  resolveContractTradeId(raw: unknown): string | null {
    return (
      this.getString(raw, ['contractTradeId']) ??
      this.getString(raw, ['data', 'contractTradeId']) ??
      this.getString(raw, ['trade', 'contractTradeId']) ??
      this.getString(raw, ['data', 'trade', 'contractTradeId'])
    );
  }

  resolveStatus(raw: unknown): string {
    return this.readOptionalStatus(raw) ?? 'unknown';
  }

  readOptionalStatus(raw: unknown): string | null {
    return (
      this.getString(raw, ['status']) ?? this.getString(raw, ['data', 'status'])
    );
  }

  isFailureStatus(status: string): boolean {
    return ['failed', 'rejected', 'expired', 'breached', 'refunded'].includes(
      status.toLowerCase(),
    );
  }

  extractSettlementHash(raw: unknown): string | null {
    return this.validTxHashOrNull(
      this.getString(raw, ['settlementTransactionHash']) ??
        this.getString(raw, ['data', 'settlementTransactionHash']) ??
        this.getString(raw, [
          'contractTransactions',
          'makerDeliver',
          'txHash',
        ]) ??
        this.getString(raw, [
          'data',
          'contractTransactions',
          'makerDeliver',
          'txHash',
        ]) ??
        this.getString(raw, [
          'contractTransactions',
          'takerDeliver',
          'txHash',
        ]) ??
        this.getString(raw, [
          'data',
          'contractTransactions',
          'takerDeliver',
          'txHash',
        ]),
    );
  }

  classifySettlement(raw: unknown): string {
    if (
      this.getString(raw, ['contractTransactions', 'makerDeliver', 'txHash']) ||
      this.getString(raw, [
        'data',
        'contractTransactions',
        'makerDeliver',
        'txHash',
      ])
    ) {
      return 'maker_deliver';
    }
    if (
      this.getString(raw, ['contractTransactions', 'takerDeliver', 'txHash']) ||
      this.getString(raw, [
        'data',
        'contractTransactions',
        'takerDeliver',
        'txHash',
      ])
    ) {
      return 'taker_deliver';
    }
    return 'settlement_transaction';
  }

  readOutputBaseUnits(raw: unknown): string | null {
    const amount =
      this.getString(raw, ['to', 'amount']) ??
      this.getString(raw, ['data', 'to', 'amount']);
    return amount ? this.decimalToBaseUnits(amount, 6) : null;
  }

  readQuoteExpiry(raw: unknown): Date | null {
    const value =
      this.getString(raw, ['expiresAt']) ??
      this.getString(raw, ['expiration']) ??
      this.getString(raw, ['data', 'expiresAt']);
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  readTransactionId(raw: unknown): string | null {
    return (
      this.getString(raw, ['transactionId']) ??
      this.getString(raw, ['txId']) ??
      this.getString(raw, ['data', 'transactionId']) ??
      this.getString(raw, ['data', 'txId'])
    );
  }

  readTransactionHash(raw: unknown): string | null {
    return this.validTxHashOrNull(
      this.getString(raw, ['transactionHash']) ??
        this.getString(raw, ['txHash']) ??
        this.getString(raw, ['data', 'transactionHash']) ??
        this.getString(raw, ['data', 'txHash']),
    );
  }

  isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private decimalToBaseUnits(value: string, decimals: number): string {
    const [wholeRaw, fractionRaw = ''] = value.trim().split('.');
    const whole = wholeRaw || '0';
    const fraction = fractionRaw.padEnd(decimals, '0').slice(0, decimals);
    if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction)) return value;
    return (
      BigInt(whole) * 10n ** BigInt(decimals) +
      BigInt(fraction || '0')
    ).toString();
  }

  private getNestedValue(raw: unknown, path: string[]): unknown {
    let current = raw;
    for (const key of path) {
      if (!this.isRecord(current)) return undefined;
      current = current[key];
    }
    return current;
  }

  private validTxHashOrNull(value: unknown): string | null {
    return typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value)
      ? value
      : null;
  }
}
