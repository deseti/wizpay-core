# Arc Mainnet deployment authorization records

Production authorization records must use `safe-eip1271-v1`, bind the exact deployment plan payload, and be validated against the final Safe on both official RPC endpoints. The Safe must return the EIP-1271 magic value for the Keccak-256 digest of the canonical, key-sorted payload JSON, and the record's signer must be a current Safe owner. Test fixtures use `ed25519-test-fixture-v1`, set `fixtureOnly` to `true`, and are rejected by production loaders.

No production authorization or signature exists in this directory. Arc Mainnet preflight therefore remains fail-closed.
