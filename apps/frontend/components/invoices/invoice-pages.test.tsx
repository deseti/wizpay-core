import { render, screen } from "@testing-library/react";
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
    activeWalletAddress:
      "0x32F251fc36A1174901124589EAC2d4E391816F69",
  }),
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

  it("fails closed on the invoice list without calling the merchant API", async () => {
    render(<InvoicesPage />);
    expect(
      await screen.findByText(
        "Invoice management unavailable on Arc Mainnet",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/remains disabled for external wallets/),
    ).toBeInTheDocument();
    expect(listInvoices).not.toHaveBeenCalled();
  });

  it("fails closed on invoice creation without submitting", async () => {
    render(<NewInvoicePage />);
    expect(
      await screen.findByText(
        "Invoice management unavailable on Arc Mainnet",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create invoice" }),
    ).not.toBeInTheDocument();
    expect(createInvoice).not.toHaveBeenCalled();
  });

  it("fails closed on the invoice detail without loading or cancelling", async () => {
    render(<InvoiceDetailPage />);
    expect(
      await screen.findByText(
        "Invoice management unavailable on Arc Mainnet",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Cancel invoice" }),
    ).not.toBeInTheDocument();
    expect(getMerchantInvoice).not.toHaveBeenCalled();
    expect(cancelInvoice).not.toHaveBeenCalled();
  });
});
