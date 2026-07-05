#!/usr/bin/env sh
set -eu

PROJECT_ROOT="/home/messyginger0804/dfwsc/dfwsc2.0"

if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_ROOT/.env"
  set +a
fi

exec npx -y @stripe/mcp
