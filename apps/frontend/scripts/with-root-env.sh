#!/bin/sh
set -e

ROOT_ENV="${ROOT_ENV_PATH:-../../.env}"

if [ -f "$ROOT_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ROOT_ENV"
  set +a
fi

exec "$@"