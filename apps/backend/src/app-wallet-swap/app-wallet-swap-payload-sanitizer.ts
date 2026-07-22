function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function shouldRemoveSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();

  return (
    normalized === 'typeddata' ||
    normalized.endsWith('signature') ||
    normalized === 'permit2' ||
    normalized.startsWith('permit2') ||
    normalized === 'authorization' ||
    normalized.startsWith('authorizationpayload') ||
    normalized === 'rawcircleresponse' ||
    normalized === 'signingpayload' ||
    normalized === 'signedpayload'
  );
}

function shouldRedactSecretKey(key: string): boolean {
  return /(api[-_]?key|authorization|bearer|entity[-_]?secret|private[-_]?key|access[-_]?token|refresh[-_]?token|user[-_]?token|encryption[-_]?key)$/i.test(
    key,
  );
}

export function describeAppWalletSwapPayloadShape(value: unknown): {
  type: string;
  keys: string[];
} {
  if (Array.isArray(value)) {
    return { type: 'array', keys: [] };
  }

  if (isRecord(value)) {
    return { type: 'object', keys: Object.keys(value).sort() };
  }

  return { type: typeof value, keys: [] };
}

export function removeSensitiveAppWalletSwapFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => removeSensitiveAppWalletSwapFields(item));
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      shouldRemoveSensitiveKey(key)
        ? []
        : [[key, removeSensitiveAppWalletSwapFields(entry)]],
    ),
  );
}

export function sanitizeAppWalletSwapPayload(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeAppWalletSwapPayload(item));
  }

  if (!isRecord(value)) {
    return typeof value === 'bigint' ? value.toString() : value;
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) => {
      if (shouldRemoveSensitiveKey(key)) {
        return [];
      }

      return [
        [
          key,
          shouldRedactSecretKey(key)
            ? '[REDACTED]'
            : sanitizeAppWalletSwapPayload(entry),
        ],
      ];
    }),
  );
}
