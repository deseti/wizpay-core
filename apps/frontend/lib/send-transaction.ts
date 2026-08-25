import {
  decodeEventLog,
  decodeFunctionData,
  getAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem";

import { ERC20_ABI } from "@/constants/erc20";
import { buildBackendUrl, resolveBackendBaseUrl } from "@/lib/backend-api";

export const ARC_NATIVE_USDC_EVENT_ADDRESS = "0xfffffffffffffffffffffffffffffffffffffffe" as Address;

const TRANSFER_EVENT = [{
  type: "event",
  name: "Transfer",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: false, name: "value", type: "uint256" },
  ],
}] as const;

function records(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(records)];
}

export function extractCircleTransactionId(...values: unknown[]) {
  for (const value of values) {
    for (const record of records(value)) {
      const correlations = record.correlationIds;
      if (Array.isArray(correlations)) {
        const id = correlations.find((entry) => typeof entry === "string" && entry.length > 0);
        if (typeof id === "string") return id;
      }
      if (typeof record.transactionId === "string" && record.transactionId) return record.transactionId;
    }
  }
  return null;
}

export function extractCircleTransactionHash(...values: unknown[]) {
  for (const value of values) {
    for (const record of records(value)) {
      for (const candidate of [record.txHash, record.transactionHash]) {
        if (typeof candidate === "string" && /^0x[a-fA-F0-9]{64}$/.test(candidate)) return candidate as Hex;
      }
    }
  }
  return null;
}

function findTransactionRecord(value: unknown): Record<string, unknown> | null {
  return records(value).find((record) =>
    typeof record.state === "string" || typeof record.txHash === "string" || typeof record.transactionHash === "string",
  ) ?? null;
}

export async function waitForCircleTransactionHash({
  signal,
  transactionId,
  attempts = 45,
  intervalMs = 2_000,
}: {
  signal?: AbortSignal;
  transactionId: string;
  attempts?: number;
  intervalMs?: number;
}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw new DOMException("Send verification was cancelled.", "AbortError");
    const response = await fetch(buildBackendUrl("/w3s/action", resolveBackendBaseUrl()), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "getTransaction", transactionId }),
      cache: "no-store",
      signal,
    });
    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error("Unable to verify the Circle transaction status.");
    const transaction = findTransactionRecord(payload);
    const state = typeof transaction?.state === "string" ? transaction.state.toUpperCase() : "";
    if (["FAILED", "CANCELLED", "DENIED"].includes(state)) {
      throw new Error(`Circle transfer ended in ${state.toLowerCase()} state.`);
    }
    const candidate = transaction?.txHash ?? transaction?.transactionHash;
    if (["COMPLETE", "CONFIRMED", "SENT"].includes(state) && typeof candidate === "string" && /^0x[a-fA-F0-9]{64}$/.test(candidate)) {
      return candidate as Hex;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Send verification was cancelled.", "AbortError")); }, { once: true });
    });
  }
  throw new Error("Circle transfer is still processing. It was not marked completed or verified.");
}

export async function verifyErc20Transfer({
  amount,
  hash,
  publicClient,
  recipient,
  sender,
  token,
}: {
  amount: bigint;
  hash: Hex;
  publicClient: PublicClient;
  recipient: Address;
  sender: Address;
  token: Address;
}) {
  const [receipt, transaction] = await Promise.all([
    publicClient.waitForTransactionReceipt({ hash, confirmations: 1 }),
    publicClient.getTransaction({ hash }),
  ]);
  assertReceipt(receipt);
  if (transaction.chainId !== publicClient.chain?.id) throw new Error("Confirmed transaction chain mismatch.");
  if (getAddress(transaction.from) !== getAddress(sender)) throw new Error("Confirmed transaction sender mismatch.");
  if (!transaction.to || getAddress(transaction.to) !== getAddress(token)) throw new Error("Confirmed transaction token mismatch.");
  const decoded = decodeFunctionData({ abi: ERC20_ABI, data: transaction.input });
  if (decoded.functionName !== "transfer") throw new Error("Confirmed transaction is not an ERC-20 transfer.");
  const [decodedRecipient, decodedAmount] = decoded.args;
  if (getAddress(decodedRecipient) !== getAddress(recipient) || decodedAmount !== amount) {
    throw new Error("Confirmed transfer calldata does not match the reviewed recipient and amount.");
  }
  const transferMatched = receipt.logs.some((log) => {
    if (getAddress(log.address) !== getAddress(token)) return false;
    try {
      const event = decodeEventLog({ abi: TRANSFER_EVENT, data: log.data, topics: log.topics });
      return event.eventName === "Transfer" && getAddress(event.args.from) === getAddress(sender) && getAddress(event.args.to) === getAddress(recipient) && event.args.value === amount;
    } catch { return false; }
  });
  if (!transferMatched) throw new Error("Confirmed receipt is missing the exact ERC-20 Transfer evidence.");
  return receipt;
}

/** Circle's Arc transfer challenge sends native USDC through ERC-4337. Arc's
 * documented unified-balance model emits its standard Transfer evidence from
 * the native system token address, with 18-decimal event units. EURC and
 * contract-interface transfers continue to require the canonical token log. */
export async function verifyCircleAppWalletTransfer({
  amount, hash, publicClient, recipient, sender, token, tokenSymbol,
}: {
  amount: bigint; hash: Hex; publicClient: PublicClient; recipient: Address;
  sender: Address; token: Address; tokenSymbol: "USDC" | "EURC";
}) {
  const [receipt, transaction] = await Promise.all([
    publicClient.waitForTransactionReceipt({ hash, confirmations: 1 }),
    publicClient.getTransaction({ hash }),
  ]);
  assertReceipt(receipt);
  if (transaction.chainId !== publicClient.chain?.id) throw new Error("Confirmed transaction chain mismatch.");
  const eventAddress = tokenSymbol === "USDC" ? ARC_NATIVE_USDC_EVENT_ADDRESS : token;
  const eventAmount = tokenSymbol === "USDC" ? amount * 1_000_000_000_000n : amount;
  const transferMatched = receipt.logs.some((log) => {
    if (getAddress(log.address) !== getAddress(eventAddress)) return false;
    try {
      const event = decodeEventLog({ abi: TRANSFER_EVENT, data: log.data, topics: log.topics });
      return event.eventName === "Transfer" && getAddress(event.args.from) === getAddress(sender) && getAddress(event.args.to) === getAddress(recipient) && event.args.value === eventAmount;
    } catch { return false; }
  });
  if (!transferMatched) throw new Error("Confirmed receipt is missing the exact App Wallet Transfer evidence.");
  return receipt;
}

function assertReceipt(receipt: TransactionReceipt) {
  if (receipt.status !== "success") throw new Error("Transfer transaction reverted.");
}
