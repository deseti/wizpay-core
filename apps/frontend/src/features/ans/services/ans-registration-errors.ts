export type AnsRegistrationStage =
  | "approval_preflight"
  | "approval"
  | "approval_confirmation"
  | "registration_preflight"
  | "registration"
  | "registration_confirmation"

type ErrorMetadata = {
  code?: string | number
  details?: string
  message?: string
  shortMessage?: string
  status?: number
}

function readErrorMetadata(error: unknown, depth = 0): ErrorMetadata[] {
  if (depth > 6 || typeof error !== "object" || error === null) {
    return error instanceof Error ? [{ message: error.message }] : []
  }

  const metadata: ErrorMetadata = {}

  for (const key of ["message", "shortMessage", "details"] as const) {
    const value = Reflect.get(error, key)
    if (typeof value === "string" && value.trim()) {
      metadata[key] = value.trim()
    }
  }

  const code = Reflect.get(error, "code")
  if (typeof code === "string" || typeof code === "number") {
    metadata.code = code
  }

  const status = Reflect.get(error, "status")
  if (typeof status === "number") {
    metadata.status = status
  }

  const cause = Reflect.get(error, "cause")
  return [metadata, ...(cause && cause !== error ? readErrorMetadata(cause, depth + 1) : [])]
}

export function isAnsRpcLimitError(error: unknown) {
  const text = readErrorMetadata(error)
    .flatMap((metadata) => [metadata.message, metadata.shortMessage, metadata.details])
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase()

  return (
    text.includes("request limit") ||
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    readErrorMetadata(error).some(
      (metadata) => metadata.code === -32011 || metadata.status === 429
    )
  )
}

export class AnsRegistrationError extends Error {
  constructor(
    message: string,
    public readonly stage: AnsRegistrationStage,
    public readonly code?: string | number,
    public readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "AnsRegistrationError"
  }
}

export function toAnsRegistrationError(
  error: unknown,
  stage: AnsRegistrationStage
): AnsRegistrationError {
  if (error instanceof AnsRegistrationError) {
    return error
  }

  const metadata = readErrorMetadata(error)
  const code = metadata.find((item) => item.code !== undefined)?.code
  const status = metadata.find((item) => item.status !== undefined)?.status

  if (isAnsRpcLimitError(error)) {
    return new AnsRegistrationError(
      `Arc RPC request limit reached during ANS ${stage.replace("_", " ")}${
        code !== undefined ? ` (code ${code})` : ""
      }. The transaction may already be confirmed; retry will reconcile on-chain before submitting again.`,
      stage,
      code,
      status,
      { cause: error }
    )
  }

  const actionableMessage = metadata
    .flatMap((item) => [item.details, item.message, item.shortMessage])
    .find(
      (message) =>
        typeof message === "string" &&
        !/^(http|rpc) request failed\.?$/i.test(message)
    )
  const fallbackMessage =
    metadata.flatMap((item) => [item.message, item.shortMessage]).find(Boolean) ??
    "Transaction rejected or failed."

  return new AnsRegistrationError(
    `${actionableMessage ?? fallbackMessage}${code !== undefined ? ` (code ${code})` : ""}`,
    stage,
    code,
    status,
    { cause: error }
  )
}
