import { describe, expect, it } from "vitest";
import { SUPPORTED_TOKENS } from "@/lib/wizpay";
import {
  clearExternalSendRecovery,
  externalSendRecoveryKey,
  readExternalSendRecovery,
  writeExternalSendRecovery,
  type ExternalWalletSendRecovery,
} from "./send-operation";

const SENDER = "0x56DE876C902AdA72CF8E7595715127cEA27d43E6";
const RECIPIENT = "0x32F251fc36A1174901124589EAC2d4E391816F69";
const CHAIN_ID = 5_042;

const recovery: ExternalWalletSendRecovery = {
  version: 1,
  executionIntentId: "intent-1",
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
  leaseOwner: "browser-1",
  operationId: "SEND-1",
  chainId: CHAIN_ID,
  sender: SENDER,
  token: "USDC",
  tokenAddress: SUPPORTED_TOKENS.USDC.address,
  recipient: RECIPIENT,
  amountUnits: "1000000",
  amountDisplay: "1",
  createdAt: new Date().toISOString(),
  stage: "awaiting_wallet_signature",
};

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } as unknown as Storage,
  };
}

describe("External Wallet Send recovery", () => {
  it("keys recovery by sender and Arc Mainnet chain", () => {
    expect(externalSendRecoveryKey(SENDER, CHAIN_ID)).toBe(
      `wizpay.send.external.v1:${SENDER.toLowerCase()}:${CHAIN_ID}`,
    );
  });

  it("persists an external-wallet intent before hash return and isolates it by sender", () => {
    const { storage } = memoryStorage();
    writeExternalSendRecovery(storage, recovery);
    expect(readExternalSendRecovery(storage, SENDER, CHAIN_ID)).toEqual(
      recovery,
    );
    expect(
      readExternalSendRecovery(
        storage,
        "0x1111111111111111111111111111111111111111",
        CHAIN_ID,
      ),
    ).toBeNull();
    clearExternalSendRecovery(storage, recovery);
    expect(readExternalSendRecovery(storage, SENDER, CHAIN_ID)).toBeNull();
  });

  it("isolates recovery across sender and chain", () => {
    const { storage } = memoryStorage();
    writeExternalSendRecovery(storage, recovery);
    expect(readExternalSendRecovery(storage, SENDER, 9_999)).toBeNull();
    expect(readExternalSendRecovery(storage, null, CHAIN_ID)).toBeNull();
    expect(readExternalSendRecovery(undefined, SENDER, CHAIN_ID)).toBeNull();
  });

  it("rejects malformed or mismatched recovery records", () => {
    const { storage, values } = memoryStorage();
    values.set(
      externalSendRecoveryKey(SENDER, CHAIN_ID),
      JSON.stringify({ ...recovery, stage: "preparing" }),
    );
    expect(readExternalSendRecovery(storage, SENDER, CHAIN_ID)).toBeNull();
    values.set(
      externalSendRecoveryKey(SENDER, CHAIN_ID),
      JSON.stringify({ ...recovery, chainId: 1 }),
    );
    expect(readExternalSendRecovery(storage, SENDER, CHAIN_ID)).toBeNull();
    values.set(externalSendRecoveryKey(SENDER, CHAIN_ID), "not-json");
    expect(readExternalSendRecovery(storage, SENDER, CHAIN_ID)).toBeNull();
  });

  it("tracks the confirming stage once the wallet returns a hash", () => {
    const { storage } = memoryStorage();
    const confirming: ExternalWalletSendRecovery = {
      ...recovery,
      txHash: `0x${"a".repeat(64)}`,
      stage: "confirming_onchain",
    };
    writeExternalSendRecovery(storage, confirming);
    expect(readExternalSendRecovery(storage, SENDER, CHAIN_ID)).toEqual(
      confirming,
    );
  });
});
