export const WIZPAY_APP_URL = "https://app.wizpay.xyz";
export const WIZPAY_SOCIAL_TITLE = "WizPay | Cross-token payroll on Arc";
export const WIZPAY_SOCIAL_DESCRIPTION =
  "Send payroll, bridge funds, swap assets, and manage liquidity from a single WizPay dashboard on Arc Testnet.";
export const WIZPAY_OG_IMAGE_URL = `${WIZPAY_APP_URL}/opengraph-image`;

interface BuildXShareUrlOptions {
  summary: string;
  explorerUrl?: string | null;
  secondaryText?: string | null;
  primaryUrl?: string;
}

export function buildXShareUrl({
  summary,
  explorerUrl,
  secondaryText,
  primaryUrl = WIZPAY_APP_URL,
}: BuildXShareUrlOptions) {
  const shareLines = [summary.trim(), primaryUrl.trim()];

  if (explorerUrl?.trim()) {
    shareLines.push(explorerUrl.trim());
  } else if (secondaryText?.trim()) {
    shareLines.push(secondaryText.trim());
  }

  return `https://x.com/intent/tweet?text=${encodeURIComponent(
    shareLines.join("\n\n")
  )}`;
}