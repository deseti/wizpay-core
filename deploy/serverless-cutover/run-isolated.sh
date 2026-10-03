#!/usr/bin/env bash
# DESTRUCTIVE ISOLATED ONLY: inherited runner owns/discards only fresh local DBs.
set -euo pipefail
cutover_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$cutover_repo"
# Phase 7 native export/restore, Phase 8 parity and Phase 9 gates/artifact/SQL.
# Every external/injected database URL is cleared by the existing isolated runner.
bash deploy/serverless-acceptance/run-isolated.sh
