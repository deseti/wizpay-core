const DEFAULT_LOCAL_ORIGIN = "http://localhost:3000";

export function getConfiguredPublicAppOrigin() {
  const configured =
    process.env.NEXT_PUBLIC_WIZPAY_PUBLIC_APP_URL?.trim() ||
    DEFAULT_LOCAL_ORIGIN;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(
      "NEXT_PUBLIC_WIZPAY_PUBLIC_APP_URL must be a valid absolute URL.",
    );
  }
  const isLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(
    url.hostname,
  );
  if (url.protocol !== "https:" && !(isLocalhost && url.protocol === "http:")) {
    throw new Error(
      "The public WizPay app URL must use HTTPS except on localhost.",
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "The public WizPay app URL cannot include credentials, query parameters, or fragments.",
    );
  }
  return url.origin;
}

export function getInvoiceCheckoutUrl(publicId: string) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(publicId))
    throw new Error("Invalid public invoice identifier.");
  return `${getConfiguredPublicAppOrigin()}/pay/${publicId}`;
}
