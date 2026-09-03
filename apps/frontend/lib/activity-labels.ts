import type { HistoryActionType } from "@/lib/types";

export const ACTIVITY_LABELS: Record<HistoryActionType, string> = {
  payroll: "Payroll",
  send: "Send",
  receive: "Receive",
  swap: "Swap",
  bridge: "Bridge",
  fx: "FX",
  invoice_payment: "Invoice Payment",
};
