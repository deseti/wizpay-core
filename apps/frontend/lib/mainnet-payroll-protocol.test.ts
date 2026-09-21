import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it } from "vitest";

import {
  ARC_MAINNET_CHAIN_ID,
  WIZPAY_PAYROLL_MAINNET_ADDRESS,
  encodeCrossTokenPayroll,
  encodePayrollApproval,
  encodeSameTokenPayroll,
  nativePayrollValue,
  payrollApprovalTarget,
  sameTokenFunding,
  splitHomogeneousPayrollGroups,
} from "./mainnet-payroll-protocol";
import {
  ARC_MAINNET_UNISWAP_V4_EURC,
  ARC_MAINNET_UNISWAP_V4_USDC,
  ARC_MAINNET_USDC_NATIVE_SCALE,
} from "./mainnet-uniswap-v4-protocol";

const ALICE = "0x1111111111111111111111111111111111111111" as const;
const BOB = "0x2222222222222222222222222222222222222222" as const;
const PAYROLL_ABI = parseAbi([
  "function executeSameTokenPayroll(address token, address[] recipients, uint256[] amounts, string referenceId) returns (uint256 totalOut)",
  "function executeCrossTokenPayroll(address tokenIn, address tokenOut, address[] recipients, uint256[] outputAmounts, uint256 grossInput, uint256 minTotalOut, uint256 minHopPriceX36, uint256 deadline, string referenceId) payable returns (uint256 amountOut)",
  "function batchRouteAndPay(address tokenIn, address[] tokenOuts, address[] recipients, uint256[] amountsIn, uint256[] minAmountsOut, string referenceId) returns (uint256 totalOut)",
]);
const APPROVE_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

describe("Arc Mainnet payroll protocol", () => {
  it("encodes executeSameTokenPayroll with fee-on-top funding", () => {
    const amounts = [100n, 200n] as const;
    const data = encodeSameTokenPayroll({
      token: ARC_MAINNET_UNISWAP_V4_USDC,
      recipients: [ALICE, BOB],
      amounts,
      referenceId: "SAME",
    });
    const decoded = decodeFunctionData({ abi: PAYROLL_ABI, data });
    expect(decoded.functionName).toBe("executeSameTokenPayroll");
    expect(decoded.args).toEqual([
      ARC_MAINNET_UNISWAP_V4_USDC,
      [ALICE, BOB],
      [100n, 200n],
      "SAME",
    ]);
    expect(sameTokenFunding(amounts, 25n)).toBe(300n + (100n * 25n) / 10_000n + (200n * 25n) / 10_000n);
    expect(nativePayrollValue(ARC_MAINNET_UNISWAP_V4_USDC, 300n)).toBe(
      300n * ARC_MAINNET_USDC_NATIVE_SCALE,
    );
    const approval = payrollApprovalTarget({
      tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
      tokenOut: ARC_MAINNET_UNISWAP_V4_USDC,
      funding: sameTokenFunding(amounts, 25n),
    });
    expect(approval?.spender).toBe(WIZPAY_PAYROLL_MAINNET_ADDRESS);
  });

  it("encodes executeCrossTokenPayroll for USDC -> EURC with native value and no approval", () => {
    const data = encodeCrossTokenPayroll({
      tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
      tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
      recipients: [ALICE, BOB],
      outputAmounts: [400n, 500n],
      grossInput: 3000n,
      minTotalOut: 900n,
      minHopPriceX36: 1n,
      deadline: 2_000_000_300,
      referenceId: "X-USDC",
    });
    const decoded = decodeFunctionData({ abi: PAYROLL_ABI, data });
    expect(decoded.functionName).toBe("executeCrossTokenPayroll");
    expect(decoded.args?.[0]).toBe(ARC_MAINNET_UNISWAP_V4_USDC);
    expect(decoded.args?.[1]).toBe(ARC_MAINNET_UNISWAP_V4_EURC);
    expect(nativePayrollValue(ARC_MAINNET_UNISWAP_V4_USDC, 3000n)).toBe(
      3000n * ARC_MAINNET_USDC_NATIVE_SCALE,
    );
    expect(
      payrollApprovalTarget({
        tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
        tokenOut: ARC_MAINNET_UNISWAP_V4_EURC,
        funding: 3000n,
      }),
    ).toBeNull();
    expect(data).not.toContain("batchRouteAndPay");
    expect(ARC_MAINNET_CHAIN_ID).toBe(5_042);
    expect(ARC_MAINNET_CHAIN_ID).not.toBe(9_999);
  });

  it("encodes EURC -> USDC approval against Payroll, not Permit2 or UniversalRouter", () => {
    const approval = payrollApprovalTarget({
      tokenIn: ARC_MAINNET_UNISWAP_V4_EURC,
      tokenOut: ARC_MAINNET_UNISWAP_V4_USDC,
      funding: 1_000n,
    });
    expect(approval).toEqual({
      token: ARC_MAINNET_UNISWAP_V4_EURC,
      spender: WIZPAY_PAYROLL_MAINNET_ADDRESS,
      amount: 1_000n,
    });
    const data = encodePayrollApproval(approval!.spender, approval!.amount);
    const decoded = decodeFunctionData({ abi: APPROVE_ABI, data });
    expect(decoded.args?.[0]).toBe(WIZPAY_PAYROLL_MAINNET_ADDRESS);
    expect(nativePayrollValue(ARC_MAINNET_UNISWAP_V4_EURC, 1_000n)).toBe(0n);
  });

  it("splits mixed destination groups deterministically and never encodes batchRouteAndPay", () => {
    const groups = splitHomogeneousPayrollGroups({
      tokenIn: ARC_MAINNET_UNISWAP_V4_USDC,
      referenceId: "MIXED",
      recipients: [
        { address: ALICE, amount: 10n, tokenOut: ARC_MAINNET_UNISWAP_V4_USDC },
        { address: BOB, amount: 20n, tokenOut: ARC_MAINNET_UNISWAP_V4_EURC },
      ],
    });
    expect(groups).toHaveLength(2);
    expect(groups[0]?.kind).toBe("same-token");
    expect(groups[1]?.kind).toBe("cross-token");
    const encoded = groups.map((group) =>
      group.kind === "same-token"
        ? encodeSameTokenPayroll({
            token: group.tokenIn,
            recipients: group.recipients,
            amounts: group.amounts,
            referenceId: group.referenceId,
          })
        : encodeCrossTokenPayroll({
            tokenIn: group.tokenIn,
            tokenOut: group.tokenOut,
            recipients: group.recipients,
            outputAmounts: group.amounts,
            grossInput: 20n,
            minTotalOut: 20n,
            minHopPriceX36: 1n,
            deadline: 2_000_000_300,
            referenceId: group.referenceId,
          }),
    );
    for (const data of encoded) {
      const decoded = decodeFunctionData({ abi: PAYROLL_ABI, data });
      expect(decoded.functionName).not.toBe("batchRouteAndPay");
    }
  });
});
