#!/usr/bin/env bash
# DESTRUCTIVE ISOLATED ONLY: fresh local fixture DBs, no production selectors.
set -euo pipefail
decommission_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$decommission_repo"
bash deploy/serverless-acceptance/run-isolated.sh
