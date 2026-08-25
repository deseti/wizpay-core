import { formatUnits, getAddress, isAddress } from "viem";

import { TOKEN_BY_ADDRESS } from "@/constants/erc20";
import { arcTestnet } from "@/lib/wagmi";
import type { TokenSymbol } from "@/lib/wizpay";

export type EvmPaymentPrefill = {
  recipient: `0x${string}`;
  chainId?: number;
  token?: TokenSymbol;
  amount?: string;
  scanned: true;
};

function checkedAddress(value: string) {
  if (!isAddress(value)) throw new Error("QR payload does not contain a valid EVM address.");
  const address = getAddress(value);
  if (/^0x0{40}$/i.test(address)) throw new Error("The zero address cannot receive a payment.");
  return address;
}

function parseChainId(raw: string | undefined) {
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw)) throw new Error("QR payload contains a malformed chain ID.");
  const chainId = Number(raw);
  if (!Number.isSafeInteger(chainId) || chainId !== arcTestnet.id) {
    throw new Error("This QR code requests an unsupported network.");
  }
  return chainId;
}

export function parseEvmPaymentPayload(rawValue: string): EvmPaymentPrefill {
  const value = rawValue.trim();
  if (isAddress(value)) return { recipient: checkedAddress(value), scanned: true };
  if (!value.toLowerCase().startsWith("ethereum:")) {
    throw new Error("Only an EVM address or supported ethereum: payment URI is accepted.");
  }

  const payload = value.slice("ethereum:".length);
  if (!payload || /[\s#]/.test(payload)) throw new Error("Malformed ethereum payment URI.");
  const [targetAndPath, query = ""] = payload.split("?");
  if (payload.split("?").length > 2) throw new Error("Malformed ethereum payment URI.");
  const [targetWithChain, action] = targetAndPath.split("/");
  const [target, rawChainId] = targetWithChain.split("@");
  const chainId = parseChainId(rawChainId);
  const params = new URLSearchParams(query);

  if (!action) {
    if (params.size > 0) throw new Error("Unsupported ethereum payment parameters.");
    return { recipient: checkedAddress(target), ...(chainId ? { chainId } : {}), scanned: true };
  }

  if (action !== "transfer") throw new Error("Unsupported ethereum payment action.");
  const tokenConfig = TOKEN_BY_ADDRESS.get(checkedAddress(target).toLowerCase());
  if (!tokenConfig) throw new Error("This QR code requests an unsupported token.");
  const recipientParam = params.get("address");
  const rawAmount = params.get("uint256");
  const allowedKeys = new Set(["address", "uint256"]);
  if ([...params.keys()].some((key) => !allowedKeys.has(key))) {
    throw new Error("Unsupported ethereum payment parameters.");
  }
  if (!recipientParam) throw new Error("Token transfer QR is missing a recipient.");
  let amount: string | undefined;
  if (rawAmount !== null) {
    if (!/^\d+$/.test(rawAmount)) throw new Error("QR payload contains a malformed amount.");
    amount = formatUnits(BigInt(rawAmount), tokenConfig.decimals);
    if (BigInt(rawAmount) <= 0n) throw new Error("QR payment amount must be positive.");
  }
  return {
    recipient: checkedAddress(recipientParam),
    ...(chainId ? { chainId } : {}),
    token: tokenConfig.symbol,
    ...(amount ? { amount } : {}),
    scanned: true,
  };
}

export function serializeSendPrefill(prefill: EvmPaymentPrefill) {
  const params = new URLSearchParams({ recipient: prefill.recipient, scanned: "1" });
  if (prefill.chainId) params.set("chainId", String(prefill.chainId));
  if (prefill.token) params.set("token", prefill.token);
  if (prefill.amount) params.set("amount", prefill.amount);
  return params.toString();
}
