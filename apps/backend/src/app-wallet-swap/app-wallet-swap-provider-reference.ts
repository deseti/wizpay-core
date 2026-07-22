const TRANSACTION_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const MAX_LEGACY_PROVIDER_SNAPSHOTS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getNestedString(value: unknown, path: string[]): string | null {
  const current = getNestedValue(value, path);

  return typeof current === 'string' && current.trim() ? current.trim() : null;
}

export function getNestedValue(value: unknown, path: string[]): unknown {
  let current = value;

  for (const key of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[key];
  }

  return current;
}

export function validTransactionHashOrNull(
  value: string | null | undefined,
): string | null {
  return value && TRANSACTION_HASH_PATTERN.test(value) ? value : null;
}

export function extractCircleTransactionHash(value: unknown): string | null {
  const candidate =
    getNestedString(value, ['data', 'transaction', 'txHash']) ??
    getNestedString(value, ['data', 'transaction', 'transactionHash']) ??
    getNestedString(value, ['data', 'transaction', 'hash']) ??
    getNestedString(value, ['transaction', 'txHash']) ??
    getNestedString(value, ['transaction', 'transactionHash']) ??
    getNestedString(value, ['transaction', 'hash']) ??
    getNestedString(value, ['txHash']) ??
    getNestedString(value, ['transactionHash']) ??
    getNestedString(value, ['hash']);

  return validTransactionHashOrNull(candidate);
}

export function extractCircleTransactionId(value: unknown): string | null {
  return (
    getNestedString(value, ['data', 'transaction', 'id']) ??
    getNestedString(value, ['data', 'transaction', 'txId']) ??
    getNestedString(value, ['transaction', 'id']) ??
    getNestedString(value, ['transaction', 'txId']) ??
    getNestedString(value, ['id']) ??
    getNestedString(value, ['txId'])
  );
}

function findInBoundedPreviousSnapshots(
  rawSnapshot: unknown,
  findValue: (snapshot: Record<string, unknown>) => string | null,
): string | null {
  const visited = new Set<object>();
  let snapshot: unknown = rawSnapshot;

  for (
    let depth = 0;
    depth < MAX_LEGACY_PROVIDER_SNAPSHOTS && isRecord(snapshot);
    depth += 1
  ) {
    if (visited.has(snapshot)) {
      return null;
    }
    visited.add(snapshot);

    const value = findValue(snapshot);
    if (value) {
      return value;
    }

    snapshot = snapshot.previous;
  }

  return null;
}

export function getPayoutTransactionId(rawPayout: unknown): string | null {
  return findInBoundedPreviousSnapshots(
    rawPayout,
    (snapshot) =>
      getNestedString(snapshot, ['transactionId']) ??
      getNestedString(snapshot, ['transfer', 'txId']) ??
      getNestedString(snapshot, ['transfer', 'id']) ??
      getNestedString(snapshot, ['status', 'txId']) ??
      getNestedString(snapshot, ['status', 'id']) ??
      getNestedString(snapshot, ['resolvedTransaction', 'txId']) ??
      getNestedString(snapshot, ['resolvedTransaction', 'id']),
  );
}

export function getPayoutTransactionHash(rawPayout: unknown): string | null {
  return findInBoundedPreviousSnapshots(
    rawPayout,
    (snapshot) =>
      extractCircleTransactionHash(snapshot) ??
      extractCircleTransactionHash(snapshot.transfer) ??
      extractCircleTransactionHash(snapshot.status) ??
      extractCircleTransactionHash(snapshot.resolvedTransaction),
  );
}
