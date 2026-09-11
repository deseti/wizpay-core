import { describe, expect, it } from "vitest";
import {
  circleRuntimeNamespace,
  resolveFrontendCircleApplicationId,
} from "./circle-network-config";

describe("frontend Circle network isolation", () => {
  it("uses distinct runtime namespaces for Circle sessions and credentials", () => {
    expect(circleRuntimeNamespace("arc-testnet")).toBe(
      "wizpay.arc-testnet.circle",
    );
    expect(circleRuntimeNamespace("arc-mainnet")).toBe(
      "wizpay.arc-mainnet.circle",
    );
  });

  it("uses only the exact selected Testnet App ID", () => {
    expect(
      resolveFrontendCircleApplicationId("arc-testnet", {
        NEXT_PUBLIC_CIRCLE_TESTNET_APP_ID: "testnet-app",
        NEXT_PUBLIC_CIRCLE_MAINNET_APP_ID: "mainnet-app",
      }),
    ).toBe("testnet-app");
  });

  it("keeps Arc Mainnet Circle initialization disabled", () => {
    expect(
      resolveFrontendCircleApplicationId("arc-mainnet", {
        NEXT_PUBLIC_CIRCLE_MAINNET_APP_ID: "configured-but-unsupported",
      }),
    ).toBe("");
  });

  it("does not fall back to an opposite-network App ID", () => {
    expect(
      resolveFrontendCircleApplicationId("arc-testnet", {
        NEXT_PUBLIC_CIRCLE_MAINNET_APP_ID: "mainnet-only",
      }),
    ).toBe("");
  });

  it("rejects a shared Testnet and Mainnet App ID", () => {
    expect(() =>
      resolveFrontendCircleApplicationId("arc-testnet", {
        NEXT_PUBLIC_CIRCLE_TESTNET_APP_ID: "shared-app",
        NEXT_PUBLIC_CIRCLE_MAINNET_APP_ID: "shared-app",
      }),
    ).toThrow("must be distinct");
  });

  it.each(["   ", " value", "value "])(
    "rejects an inexact selected App ID: %p",
    (value) => {
      expect(() =>
        resolveFrontendCircleApplicationId("arc-testnet", {
          NEXT_PUBLIC_CIRCLE_TESTNET_APP_ID: value,
        }),
      ).toThrow();
    },
  );

  it("treats a missing or empty selected App ID as disabled", () => {
    expect(resolveFrontendCircleApplicationId("arc-testnet", {})).toBe("");
    expect(
      resolveFrontendCircleApplicationId("arc-testnet", {
        NEXT_PUBLIC_CIRCLE_TESTNET_APP_ID: "",
      }),
    ).toBe("");
  });

  it("rejects the generic App ID instead of treating it as a fallback", () => {
    expect(() =>
      resolveFrontendCircleApplicationId("arc-testnet", {
        NEXT_PUBLIC_CIRCLE_APP_ID: "generic-app",
      }),
    ).toThrow("ambiguous");
  });
});
