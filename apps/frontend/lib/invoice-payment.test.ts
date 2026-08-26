import { describe, expect, it } from "vitest";
import {
  buildInvoiceTransferRequest,
  clearInvoicePaymentRecovery,
  isInvoiceSelfPayment,
  readInvoicePaymentRecovery,
  writeInvoicePaymentRecovery,
} from "@/lib/invoice-payment";

const TOKEN = "0x3600000000000000000000000000000000000000";
const MERCHANT = "0x32F251fc36A1174901124589EAC2d4E391816F69";
const HASH = `0x${"a".repeat(64)}` as const;

describe("invoice payment primitives", () => {
  it("builds one exact ERC-20 transfer request with immutable invoice terms", () => {
    expect(
      buildInvoiceTransferRequest({
        chainId: 5_042_002,
        tokenAddress: TOKEN,
        recipient: MERCHANT,
        amountUnits: "100000",
      }),
    ).toMatchObject({
      address: TOKEN,
      chainId: 5_042_002,
      functionName: "transfer",
      args: [MERCHANT, 100000n],
    });
  });

  it("detects self-payment case-insensitively", () => {
    expect(
      isInvoiceSelfPayment(MERCHANT, MERCHANT.toLowerCase() as `0x${string}`),
    ).toBe(true);
    expect(
      isInvoiceSelfPayment(
        "0x1111111111111111111111111111111111111111",
        MERCHANT,
      ),
    ).toBe(false);
  });

  it("preserves the minimal external-wallet refresh record", () => {
    const recovery = {
      method: "external" as const,
      publicId: "abcdefghijklmnopqrstuv",
      transactionHash: HASH,
      createdAt: new Date().toISOString(),
    };
    writeInvoicePaymentRecovery(recovery, localStorage);
    expect(readInvoicePaymentRecovery(recovery.publicId, localStorage)).toEqual(
      recovery,
    );
    expect(
      JSON.parse(
        localStorage.getItem(`wizpay.invoice-payment.v1.${recovery.publicId}`)!,
      ),
    ).toEqual(recovery);
    clearInvoicePaymentRecovery(recovery.publicId, localStorage);
    expect(
      readInvoicePaymentRecovery(recovery.publicId, localStorage),
    ).toBeNull();
  });

  it("persists an App Wallet challenge identity without persisting a bearer token", () => {
    const recovery = {
      version: 2 as const,
      method: "app" as const,
      publicId: "abcdefghijklmnopqrstuv",
      authMethod: "email" as const,
      walletId: "arc-wallet-1",
      payerAddress: "0x2222222222222222222222222222222222222222" as const,
      challengeId: "challenge-1",
      createdAt: new Date().toISOString(),
      stage: "awaiting_user_authorization" as const,
    };
    writeInvoicePaymentRecovery(recovery, localStorage);
    expect(readInvoicePaymentRecovery(recovery.publicId, localStorage)).toEqual(recovery);
    expect(localStorage.getItem(`wizpay.invoice-payment.v1.${recovery.publicId}`)).not.toContain("circle-user-token");
  });
});
