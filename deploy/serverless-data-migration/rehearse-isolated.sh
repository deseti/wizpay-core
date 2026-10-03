#!/usr/bin/env bash
# Linux/Docker development convenience. Only newly created loopback containers
# and synthetic test databases are used; no external credentials are consumed.
set -euo pipefail
rehearsal_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
rehearsal_temp="$(mktemp -d /tmp/wizpay-phase7-local.XXXXXXXX)"
rehearsal_id="$(node -e "process.stdout.write(require('node:crypto').randomUUID().replaceAll('-', ''))")"
rehearsal_source="wizpay-phase7-source-${rehearsal_id}"
rehearsal_target="wizpay-phase7-target-${rehearsal_id}"
rehearsal_docker() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host unix:///var/run/docker.sock "$@"
}
rehearsal_cleanup() {
  rehearsal_docker rm -f "$rehearsal_source" "$rehearsal_target" >/dev/null 2>&1 || true
  rm -rf "$rehearsal_temp"
}
trap rehearsal_cleanup EXIT
test "$(uname -s)" = Linux
rehearsal_docker info >/dev/null
for rehearsal_spec in "$rehearsal_source:15" "$rehearsal_target:17"; do
  rehearsal_name="${rehearsal_spec%:*}"
  rehearsal_version="${rehearsal_spec##*:}"
  rehearsal_docker run --rm -d --name "$rehearsal_name" \
    -e POSTGRES_PASSWORD=phase7-local-only -e POSTGRES_DB=wizpay_phase7_test_admin \
    -p 127.0.0.1::5432 "public.ecr.aws/docker/library/postgres:${rehearsal_version}" >/dev/null
  rehearsal_ready=false
  for rehearsal_attempt in {1..60}; do
    if rehearsal_docker exec "$rehearsal_name" pg_isready -U postgres -d wizpay_phase7_test_admin >/dev/null 2>&1; then
      rehearsal_ready=true
      break
    fi
    sleep 1
  done
  test "$rehearsal_ready" = true
done
mkdir -p "$rehearsal_temp/bin" "$rehearsal_temp/lib"
# Matching PG17 native clients from the verified official image. Verify host
# compatibility before testing; production/manual use can use installed PG17 tools.
for rehearsal_tool in pg_dump pg_restore; do
  rehearsal_docker cp "$rehearsal_target:/usr/lib/postgresql/17/bin/$rehearsal_tool" "$rehearsal_temp/bin/$rehearsal_tool"
done
rehearsal_docker cp -L "$rehearsal_target:/lib/x86_64-linux-gnu/libpq.so.5" "$rehearsal_temp/lib/libpq.so.5"
export LD_LIBRARY_PATH="$rehearsal_temp/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
"$rehearsal_temp/bin/pg_dump" --version >/dev/null
"$rehearsal_temp/bin/pg_restore" --version >/dev/null
rehearsal_source_port="$(rehearsal_docker port "$rehearsal_source" 5432/tcp)"
rehearsal_target_port="$(rehearsal_docker port "$rehearsal_target" 5432/tcp)"
[[ "$rehearsal_source_port" =~ ^127\.0\.0\.1:[0-9]+$ ]]
[[ "$rehearsal_target_port" =~ ^127\.0\.0\.1:[0-9]+$ ]]
unset DATABASE_URL DIRECT_URL WIZPAY_EXTERNAL_TEST_DATABASE_URL WIZPAY_EXTERNAL_TEST_RUNTIME_DATABASE_URL
export PHASE7_MIGRATION_SOURCE_TEST_DATABASE_URL="postgresql://postgres:phase7-local-only@${rehearsal_source_port}/wizpay_phase7_test_admin"
export PHASE7_MIGRATION_TEST_DATABASE_URL="postgresql://postgres:phase7-local-only@${rehearsal_target_port}/wizpay_phase7_test_admin"
export PHASE7_TEST_DATABASE_URL="$PHASE7_MIGRATION_TEST_DATABASE_URL"
export WIZPAY_REHEARSAL_PG_BIN="$rehearsal_temp/bin"
export WIZPAY_PHASE7_EVIDENCE_FILE="$rehearsal_temp/evidence.json"
cd "$rehearsal_repo"
npm run prisma:generate -w backend
npm run test:phase7:offline -w backend
cat "$WIZPAY_PHASE7_EVIDENCE_FILE"
