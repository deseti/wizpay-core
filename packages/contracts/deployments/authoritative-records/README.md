# Authoritative Arc Mainnet records

Production records in this directory must reproduce an official Arc or Circle publication, remain regular Git-tracked files, and set `fixtureOnly` to `false`. A record is evidence, not an activation switch: deployment preflight also requires a separately verified authorization record.

Test fixtures must live under `fixtures/`, set `fixtureOnly` to `true`, and are rejected unless a test-only loader is explicitly enabled.
