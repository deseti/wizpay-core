# External Wallet CCTP V2 capability matrix

This matrix is the fail-closed testnet configuration used by WizPay's browser-direct External Wallet bridge. Circle's current CCTP V2 supported-chain, contract-address, USDC-address, interface, finality, and technical-guide pages are authoritative. All exposed routes remain Arc hub-and-spoke routes; unsupported routes are rejected before wallet authorization.

| Network          | Chain ID | Domain | Native USDC                                  | TokenMessengerV2                             | MessageTransmitterV2                         | Standard source | Fast source | Destination | Gas  | Decimals | Finality |
| ---------------- | -------: | -----: | -------------------------------------------- | -------------------------------------------- | -------------------------------------------- | --------------- | ----------- | ----------- | ---- | -------: | -------: |
| Arc Testnet      |  5042002 |     26 | `0x3600000000000000000000000000000000000000` | `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA` | `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` | Yes             | N/A         | Yes         | USDC |        6 |     2000 |
| Ethereum Sepolia | 11155111 |      0 | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | same official V2 address                     | same official V2 address                     | Yes             | Yes         | Yes         | ETH  |        6 |     2000 |
| Base Sepolia     |    84532 |      6 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | same official V2 address                     | same official V2 address                     | Yes             | Yes         | Yes         | ETH  |        6 |     2000 |
| Arbitrum Sepolia |   421614 |      3 | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | same official V2 address                     | same official V2 address                     | Yes             | Yes         | Yes         | ETH  |        6 |     2000 |
| OP Sepolia       | 11155420 |      2 | `0x5fd84259d66Cd46123540766Be93DFE6D43130D7` | same official V2 address                     | same official V2 address                     | Yes             | Yes         | Yes         | ETH  |        6 |     2000 |
| Monad Testnet    |    10143 |     15 | `0x534b2f3A21130d7a60830c2Df862319e593943A3` | same official V2 address                     | same official V2 address                     | Yes             | N/A         | Yes         | MON  |        6 |     2000 |

WizPay currently selects Standard Transfer only. A declared Fast capability does not activate Fast Transfer. Every source burn uses `minFinalityThreshold = 2000`; Arc and Monad are explicitly marked as not having a meaningful Fast Transfer source mode in Circle's capability table.

RPC and explorer URLs are registry fields, not application-logic constants. Browser RPC environment variables may override the documented public defaults. Mainnet chain IDs and CCTP V1 contracts are rejected by registry validation.

Official sources reviewed on 2026-08-24:

- Circle CCTP supported blockchains and domains
- Circle CCTP EVM contract addresses and interfaces
- Circle CCTP technical guide and finality documentation
- Circle USDC contract addresses
- Circle CCTP V1-to-V2 migration and troubleshooting guides
- Circle Ethereum-to-Arc direct-mint quickstart
- Arc CCTP bridging guide
