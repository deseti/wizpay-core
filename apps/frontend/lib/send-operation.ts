import { getAddress, isAddress, type Address, type Hex } from "viem";

import type { TokenSymbol } from "@/lib/wizpay";

export const EXTERNAL_SEND_RECOVERY_PREFIX = "wizpay.send.external.v1";

export type ExternalWalletSendRecovery = {
  version: 1;
  executionIntentId: string;
  idempotencyKey: string;
  leaseOwner: string;
  operationId: string;
  chainId: number;
  sender: Address;
  token: TokenSymbol;
  tokenAddress: Address;
  recipient: Address;
  amountUnits: string;
  amountDisplay: string;
  txHash?: Hex;
  createdAt: string;
  stage: "awaiting_wallet_signature" | "confirming_onchain";
};

export function externalSendRecoveryKey(sender: Address, chainId: number) {
  return `${EXTERNAL_SEND_RECOVERY_PREFIX}:${sender.toLowerCase()}:${chainId}`;
}

export function readExternalSendRecovery(
  storage: Storage | undefined,
  sender: Address | null,
  chainId: number,
): ExternalWalletSendRecovery | null {
  if (!storage || !sender) return null;
  try {
    const value = JSON.parse(
      storage.getItem(externalSendRecoveryKey(sender, chainId)) ?? "null",
    ) as Record<string, unknown> | null;
    if (
      !value ||
      value.version !== 1 ||
      typeof value.executionIntentId !== "string" ||
      !value.executionIntentId ||
      typeof value.idempotencyKey !== "string" ||
      !value.idempotencyKey ||
      typeof value.leaseOwner !== "string" ||
      !value.leaseOwner ||
      typeof value.operationId !== "string" ||
      !value.operationId ||
      value.chainId !== chainId ||
      !isAddress(String(value.sender ?? "")) ||
      getAddress(String(value.sender)) !== getAddress(sender) ||
      !isAddress(String(value.tokenAddress ?? "")) ||
      !isAddress(String(value.recipient ?? "")) ||
      (value.token !== "USDC" && value.token !== "EURC") ||
      typeof value.amountUnits !== "string" ||
      !/^\d+$/.test(value.amountUnits) ||
      typeof value.amountDisplay !== "string" ||
      !value.amountDisplay ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      !["awaiting_wallet_signature", "confirming_onchain"].includes(
        String(value.stage),
      ) ||
      (value.txHash !== undefined &&
        (typeof value.txHash !== "string" ||
          !/^0x[a-fA-F0-9]{64}$/.test(value.txHash)))
    )
      return null;
    return {
      ...(value as unknown as ExternalWalletSendRecovery),
      sender: getAddress(String(value.sender)),
      recipient: getAddress(String(value.recipient)),
      tokenAddress: getAddress(String(value.tokenAddress)),
    };
  } catch {
    return null;
  }
}

export function writeExternalSendRecovery(
  storage: Storage | undefined,
  recovery: ExternalWalletSendRecovery,
) {
  storage?.setItem(
    externalSendRecoveryKey(recovery.sender, recovery.chainId),
    JSON.stringify(recovery),
  );
}

export function clearExternalSendRecovery(
  storage: Storage | undefined,
  recovery: ExternalWalletSendRecovery,
) {
  storage?.removeItem(
    externalSendRecoveryKey(recovery.sender, recovery.chainId),
  );
}
