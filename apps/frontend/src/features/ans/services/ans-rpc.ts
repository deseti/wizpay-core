const ANS_RPC_MIN_INTERVAL_MS = 1_500
const ANS_RPC_MAX_ATTEMPTS = 3

let ansRpcQueue: Promise<void> = Promise.resolve()
let lastAnsRpcStartedAt = 0

const inFlightAnsReads = new Map<string, Promise<unknown>>()

function waitFor(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })
}

function getRpcErrorText(error: unknown, depth = 0): string {
  if (depth > 4 || typeof error !== "object" || error === null) {
    return error instanceof Error ? error.message : String(error ?? "")
  }

  const parts = ["name", "message", "shortMessage", "details"]
    .map((key) => Reflect.get(error, key))
    .filter((value): value is string => typeof value === "string")
  const cause = Reflect.get(error, "cause")

  if (cause && cause !== error) {
    parts.push(getRpcErrorText(cause, depth + 1))
  }

  return parts.join(" ").toLowerCase()
}

function isTransientAnsRpcError(error: unknown) {
  const errorText = getRpcErrorText(error)

  if (
    errorText.includes("execution reverted") ||
    errorText.includes("contract function execution error") ||
    errorText.includes("returned no data")
  ) {
    return false
  }

  return [
    "429",
    "request limit",
    "rate limit",
    "too many requests",
    "temporarily unavailable",
    "rpc request failed",
    "http request failed",
    "fetch failed",
    "network error",
    "timed out",
    "timeout",
  ].some((fragment) => errorText.includes(fragment))
}

async function waitForAnsRpcWindow() {
  const elapsed = Date.now() - lastAnsRpcStartedAt
  const remaining = ANS_RPC_MIN_INTERVAL_MS - elapsed

  if (remaining > 0) {
    await waitFor(remaining)
  }
}

function enqueueAnsRpcRead<T>(read: () => Promise<T>) {
  const queuedRead = ansRpcQueue.then(read, read)
  ansRpcQueue = queuedRead.then(
    () => undefined,
    () => undefined
  )
  return queuedRead
}

export function runAnsRpcRead<T>(requestKey: string, read: () => Promise<T>) {
  const existingRead = inFlightAnsReads.get(requestKey) as Promise<T> | undefined

  if (existingRead) {
    return existingRead
  }

  const queuedRead = enqueueAnsRpcRead(async () => {
    for (let attempt = 1; attempt <= ANS_RPC_MAX_ATTEMPTS; attempt += 1) {
      await waitForAnsRpcWindow()
      lastAnsRpcStartedAt = Date.now()

      try {
        return await read()
      } catch (error) {
        const canRetry =
          isTransientAnsRpcError(error) && attempt < ANS_RPC_MAX_ATTEMPTS

        if (!canRetry) {
          throw error
        }

        await waitFor(ANS_RPC_MIN_INTERVAL_MS * 2 ** (attempt - 1))
      }
    }

    throw new Error("ANS RPC read exhausted its retry window.")
  })

  inFlightAnsReads.set(requestKey, queuedRead)

  const clearInFlightRead = () => {
    if (inFlightAnsReads.get(requestKey) === queuedRead) {
      inFlightAnsReads.delete(requestKey)
    }
  }

  void queuedRead.then(clearInFlightRead, clearInFlightRead)

  return queuedRead
}
