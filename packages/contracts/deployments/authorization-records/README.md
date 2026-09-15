# Arc Mainnet deployment authorization records

Production authorization records must use `safe-eip1271-v1`, bind the exact deployment plan payload, and be validated against the final Safe. Test fixtures use `ed25519-test-fixture-v1`, set `fixtureOnly` to `true`, and are rejected by production loaders.

No production authorization or signature exists in this directory. Arc Mainnet preflight therefore remains fail-closed.
