import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureExternalWalletRegistered } from "./wallet-registration";
import { backendFetch } from "./backend-api";

vi.mock("./backend-api", () => ({
  backendFetch: vi.fn(),
}));

const WALLET = "0x32F251fc36A1174901124589EAC2d4E391816F69";

describe("wallet-registration", () => {
  afterEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it("registers the external wallet and persists the stable user id", async () => {
    const userId = "11111111-1111-4111-8111-111111111111";
    vi.mocked(backendFetch).mockResolvedValue({
      address: WALLET,
      userId,
    });
    const first = await ensureExternalWalletRegistered(WALLET);
    expect(first).toMatchObject({ address: WALLET, userId });
    expect(backendFetch).toHaveBeenCalledWith(
      "/wallets/register-external",
      expect.objectContaining({ method: "POST" }),
    );
    const second = await ensureExternalWalletRegistered(WALLET);
    expect(second.userId).toBe(userId);
    const body = JSON.parse(
      vi.mocked(backendFetch).mock.calls[1]?.[1]?.body as string,
    );
    expect(body.userId).toBe(userId);
  });

  it("rejects invalid wallet addresses without calling the backend", async () => {
    await expect(ensureExternalWalletRegistered("nope")).rejects.toThrow(
      "Connect an external wallet",
    );
    expect(backendFetch).not.toHaveBeenCalled();
  });
});
