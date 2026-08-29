import { describe, expect, it } from "vitest";

import {
  selectBackendWalletForBlockchain,
  type BackendManagedCircleWallet,
} from "./backend-wallets";

describe("backend wallet selection", () => {
  it("selects the affected account's exact Arc wallet when EVM addresses repeat across chains", () => {
    const wallets: BackendManagedCircleWallet[] = [
      {
        address: "0x8935e73022ae4804a75ed97e2fd22cbb9b0fe98a",
        blockchain: "ETH-SEPOLIA",
        chain: "EVM",
        id: "4de44d4c-82c6-523d-8107-1ef9a77cfb49",
        userId: "circle:user:39b4cc00-e46c-5dba-8d8b-08cf1d134d89",
        walletSetId: "da64f5b2-d64c-54d5-b407-0025e603ce19",
      },
      {
        address: "HuVFzzfwmkWjveJQ38WggTKJj6V1sLyBbKtWEHUKvFp7",
        blockchain: "SOLANA-DEVNET",
        chain: "SOLANA",
        id: "113e74a7-cbfb-58b8-a380-98810a03a65e",
        userId: "circle:user:39b4cc00-e46c-5dba-8d8b-08cf1d134d89",
        walletSetId: "da64f5b2-d64c-54d5-b407-0025e603ce19",
      },
      {
        address: "0x8935e73022ae4804a75ed97e2fd22cbb9b0fe98a",
        blockchain: "ARC-TESTNET",
        chain: "EVM",
        id: "7c4eb02d-5012-57b6-9f70-ff4661a14af4",
        userId: "circle:user:39b4cc00-e46c-5dba-8d8b-08cf1d134d89",
        walletSetId: "da64f5b2-d64c-54d5-b407-0025e603ce19",
      },
    ];

    expect(selectBackendWalletForBlockchain(wallets, "ARC-TESTNET")?.id).toBe(
      "7c4eb02d-5012-57b6-9f70-ff4661a14af4",
    );
  });

  it("does not fall back to a different blockchain", () => {
    const wallets: BackendManagedCircleWallet[] = [
      {
        address: "0x1111111111111111111111111111111111111111",
        blockchain: "ETH-SEPOLIA",
        chain: "EVM",
        id: "sepolia-wallet",
        userId: "account-2",
        walletSetId: null,
      },
    ];
    expect(selectBackendWalletForBlockchain(wallets, "ARC-TESTNET")).toBeNull();
  });
});
