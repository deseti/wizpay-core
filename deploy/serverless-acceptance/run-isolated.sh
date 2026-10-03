#!/usr/bin/env bash
# Only disposable loopback containers, synthetic fixtures and native PG clients.
set -euo pipefail
acceptance_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
acceptance_temp="$(mktemp -d /tmp/wizpay-phase8.XXXXXXXX)"
acceptance_id="$(node -e "process.stdout.write(require('node:crypto').randomUUID().replaceAll('-', ''))")"
acceptance_source="wizpay-phase8-source-${acceptance_id}"
acceptance_target="wizpay-phase8-target-${acceptance_id}"
acceptance_docker() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host unix:///var/run/docker.sock "$@"
}
acceptance_cleanup() {
  acceptance_docker rm -f "$acceptance_source" "$acceptance_target" >/dev/null 2>&1 || true
  rm -rf "$acceptance_temp"
}
trap acceptance_cleanup EXIT
acceptance_docker info >/dev/null
for acceptance_spec in "$acceptance_source:15" "$acceptance_target:17"; do
  acceptance_name="${acceptance_spec%:*}"
  acceptance_version="${acceptance_spec##*:}"
  acceptance_docker run --rm -d --name "$acceptance_name" \
    -e POSTGRES_PASSWORD=phase8-local-only -e POSTGRES_DB=wizpay_phase7_test_admin \
    -p 127.0.0.1::5432 "public.ecr.aws/docker/library/postgres:${acceptance_version}" >/dev/null
  acceptance_ready=false
  for acceptance_attempt in {1..60}; do
    if acceptance_docker exec "$acceptance_name" pg_isready -U postgres -d wizpay_phase7_test_admin >/dev/null 2>&1; then
      acceptance_ready=true
      break
    fi
    sleep 1
  done
  test "$acceptance_ready" = true
done
for acceptance_database in wizpay_phase5_test_admin wizpay_execution_intent_test_admin wizpay_phase6_test_admin; do
  acceptance_docker exec "$acceptance_target" createdb -U postgres "$acceptance_database"
done
mkdir -p "$acceptance_temp/bin" "$acceptance_temp/lib"
for acceptance_tool in pg_dump pg_restore; do
  acceptance_docker cp "$acceptance_target:/usr/lib/postgresql/17/bin/$acceptance_tool" "$acceptance_temp/bin/$acceptance_tool"
done
acceptance_docker cp -L "$acceptance_target:/lib/x86_64-linux-gnu/libpq.so.5" "$acceptance_temp/lib/libpq.so.5"
export LD_LIBRARY_PATH="$acceptance_temp/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
"$acceptance_temp/bin/pg_dump" --version >/dev/null
acceptance_source_port="$(acceptance_docker port "$acceptance_source" 5432/tcp)"
acceptance_target_port="$(acceptance_docker port "$acceptance_target" 5432/tcp)"
[[ "$acceptance_source_port" =~ ^127\.0\.0\.1:[0-9]+$ ]]
[[ "$acceptance_target_port" =~ ^127\.0\.0\.1:[0-9]+$ ]]
unset DATABASE_URL DIRECT_URL WIZPAY_EXTERNAL_TEST_DATABASE_URL WIZPAY_EXTERNAL_TEST_RUNTIME_DATABASE_URL
export PHASE7_MIGRATION_SOURCE_TEST_DATABASE_URL="postgresql://postgres:phase8-local-only@${acceptance_source_port}/wizpay_phase7_test_admin"
export PHASE7_MIGRATION_TEST_DATABASE_URL="postgresql://postgres:phase8-local-only@${acceptance_target_port}/wizpay_phase7_test_admin"
export PHASE7_TEST_DATABASE_URL="$PHASE7_MIGRATION_TEST_DATABASE_URL"
export PHASE5_TEST_DATABASE_URL="postgresql://postgres:phase8-local-only@${acceptance_target_port}/wizpay_phase5_test_admin"
export EXECUTION_INTENT_TEST_DATABASE_URL="postgresql://postgres:phase8-local-only@${acceptance_target_port}/wizpay_execution_intent_test_admin"
export VERCEL_API_TEST_DATABASE_URL="postgresql://postgres:phase8-local-only@${acceptance_target_port}/wizpay_phase6_test_admin"
export WIZPAY_REHEARSAL_PG_BIN="$acceptance_temp/bin"
export WIZPAY_PHASE7_EVIDENCE_FILE="$acceptance_temp/rehearsal.json"
cd "$acceptance_repo"
npm run prisma:generate -w backend
(cd apps/backend && npx prisma validate --schema src/database/schema.prisma)
npm run build:vercel -w backend
npm test -w backend -- --runInBand --json --outputFile="$acceptance_temp/backend.json"
npm test -w frontend -- --reporter=json --outputFile="$acceptance_temp/frontend.json"
ROOT_ENV_PATH=/dev/null NEXT_PUBLIC_WIZPAY_ARC_NETWORK=arc-mainnet NEXT_PUBLIC_API_URL=http://127.0.0.1:4000 npm run build -w frontend
(cd apps/backend && npx tsc --noEmit)
(cd apps/frontend && npx tsc --noEmit)
# Use installed Playwright Chromium, or an explicit local executable. No hosted
# wallet/provider authentication is needed; all browser remote calls are fixtures.
(cd apps/frontend && ../../node_modules/.bin/playwright test --reporter=json > "$acceptance_temp/browser.json")
node deploy/serverless-acceptance/verify-evidence.mjs "$acceptance_temp/backend.json" "$acceptance_temp/frontend.json" "$acceptance_temp/browser.json"
node deploy/serverless-cutover/verify-evidence.mjs "$acceptance_temp/backend.json" "$acceptance_temp/frontend.json"
git diff --check
node - "$acceptance_temp/backend.json" <<'NODE'
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (!report.success) process.exit(1);
console.log(JSON.stringify({ stage: 'phase8-isolated', status: 'PASS', suites: report.numPassedTestSuites, tests: report.numPassedTests, skipped: report.numPendingTests }));
NODE
