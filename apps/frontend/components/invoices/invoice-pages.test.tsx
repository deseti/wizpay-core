import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import InvoicesPage from "@/app/invoices/page";
import NewInvoicePage from "@/app/invoices/new/page";
import InvoiceDetailPage from "@/app/invoices/[id]/page";
import {
  cancelInvoice,
  createInvoice,
  getMerchantInvoice,
  listInvoices,
} from "@/lib/invoice-api";

const WALLET = "0x32F251fc36A1174901124589EAC2d4E391816F69";

vi.mock("@/components/providers/CapabilityProvider", () => ({
  useCapability: () => ({
    enabled: true,
    unavailableMessage: null,
    assertEnabled: vi.fn(),
  }),
}));

vi.mock("@/components/providers/external-wallet-context", () => ({
  useExternalWallet: () => ({
    isReady: true,
    activeWalletAddress: WALLET,
  }),
}));

vi.mock("@/components/providers/WalletAuthProvider", () => ({
  useWalletAuth: () => ({
    authenticate: vi.fn(),
    error: null,
    sessionToken: "opaque-wallet-session",
    state: "authenticated",
  }),
}));

vi.mock("@reown/appkit/react", () => ({
  useAppKit: () => ({ open: vi.fn() }),
}));

vi.mock("@/components/dashboard/DashboardAppFrame", () => ({
  DashboardAppFrame: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "3fcbcc73-3471-4e64-8dda-63c12ebf6c3c" }),
  usePathname: () => "/invoices",
}));
vi.mock("@/lib/invoice-api", async (original) => ({
  ...(await original<typeof import("@/lib/invoice-api")>()),
  listInvoices: vi.fn(),
  createInvoice: vi.fn(),
  getMerchantInvoice: vi.fn(),
  cancelInvoice: vi.fn(),
}));

describe("merchant invoice pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists merchant invoices for the registered external wallet", async () => {
    vi.mocked(listInvoices).mockResolvedValue({
      items: [],
      total: 0,
      limit: 10,
      offset: 0,
    });
    render(<InvoicesPage />);
    await waitFor(() =>
      expect(listInvoices).toHaveBeenCalledWith(
        "opaque-wallet-session",
        expect.objectContaining({ limit: 10, offset: 0 }),
      ),
    );
    expect(
      await screen.findByText("No invoices found", undefined, {
        timeout: 3000,
      }),
    ).toBeInTheDocument();
  });

  it("renders the creation form for the registered external wallet", async () => {
    render(<NewInvoicePage />);
    expect(
      await screen.findByRole("button", { name: "Create invoice" }),
    ).toBeInTheDocument();
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it("loads the invoice detail for the registered external wallet", async () => {
    vi.mocked(getMerchantInvoice).mockResolvedValue({
      id: "3fcbcc73-3471-4e64-8dda-63c12ebf6c3c",
      publicId: "public-id-123456789012",
      settlementOperation: "INVOICE_SETTLEMENT",
      merchantDisplayLabel: null,
      receivingAddress: WALLET as `0x${string}`,
      receivingAddressShort: "0x32F2...816F69",
      chain: { id: 5042, name: "Arc Mainnet" },
      token: {
        symbol: "USDC",
        name: "USD Coin",
        address: "0x3600000000000000000000000000000000000000",
        decimals: 6,
      },
      amount: "10",
      amountUnits: "10000000",
      title: "Consulting",
      description: null,
      expiresAt: null,
      status: "OPEN",
      paymentStatus: null,
      verificationCode: null,
      transactionHash: null,
      paidAt: null,
      invoiceNumber: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cancelledAt: null,
      payerAddress: null,
    });
    render(<InvoiceDetailPage />);
    await waitFor(() =>
      expect(getMerchantInvoice).toHaveBeenCalledWith(
        "3fcbcc73-3471-4e64-8dda-63c12ebf6c3c",
        "opaque-wallet-session",
      ),
    );
    expect(await screen.findByText("Consulting")).toBeInTheDocument();
    expect(cancelInvoice).not.toHaveBeenCalled();
  });
});
