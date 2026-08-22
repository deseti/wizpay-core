import type {
  AppWalletSwapQuoteResponse,
  AppWalletXylonetOperationResponse,
} from "@/lib/app-wallet-swap-service";
import type { TokenSymbol } from "@/lib/wizpay";

interface ExpectedXylonetPayrollRoute {
  sourceToken: TokenSymbol;
  targetToken: TokenSymbol;
  amountIn: string;
  walletAddress: string;
}

function isPositiveBaseUnits(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value) && BigInt(value) > 0n;
}

function addressMatches(value: string | undefined, expected: string) {
  return value?.toLowerCase() === expected.toLowerCase();
}

export function validateXylonetPayrollQuote(
  quote: AppWalletSwapQuoteResponse,
  expected: ExpectedXylonetPayrollRoute,
) {
  if (
    quote.provider !== "xylonet" ||
    quote.tokenIn !== expected.sourceToken ||
    quote.tokenOut !== expected.targetToken ||
    quote.amountIn !== expected.amountIn ||
    !addressMatches(quote.walletAddress, expected.walletAddress) ||
    !addressMatches(quote.recipientAddress, expected.walletAddress) ||
    !isPositiveBaseUnits(quote.expectedOutput) ||
    !isPositiveBaseUnits(quote.minimumOutput)
  ) {
    throw new Error("XyloNet Payroll quote validation failed.");
  }
}

export function readVerifiedXylonetPayrollOutput(
  operation: AppWalletXylonetOperationResponse,
  expected: ExpectedXylonetPayrollRoute,
) {
  validateXylonetPayrollOperation(operation, expected);
  if (
    operation.lifecycleStage !== "completed" ||
    operation.terminalStatus !== "confirmed" ||
    !isPositiveBaseUnits(operation.verifiedActualOutput)
  ) {
    throw new Error("Confirmed XyloNet Payroll output validation failed.");
  }
  return operation.verifiedActualOutput;
}

export function validateXylonetPayrollOperation(
  operation: AppWalletXylonetOperationResponse,
  expected: ExpectedXylonetPayrollRoute,
) {
  if (
    operation.provider !== "xylonet" ||
    operation.executionMode !== "direct-user-controlled" ||
    operation.tokenIn !== expected.sourceToken ||
    operation.tokenOut !== expected.targetToken ||
    operation.amountIn !== expected.amountIn ||
    !addressMatches(operation.walletAddress, expected.walletAddress) ||
    !addressMatches(operation.recipientAddress, expected.walletAddress) ||
    !isPositiveBaseUnits(operation.expectedOutput) ||
    !isPositiveBaseUnits(operation.minimumOutput)
  ) {
    throw new Error("XyloNet Payroll operation validation failed.");
  }
}
