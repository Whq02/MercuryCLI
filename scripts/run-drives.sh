#!/usr/bin/env bash
set -euo pipefail
if [ "$#" -gt 0 ] && { [ "$#" -ne 1 ] || [ "$1" != --plan-only ]; }; then
  printf 'usage: bash scripts/run-drives.sh [--plan-only] (build first; run in the background as a guide)\n' >&2
  exit 2
fi
exec nice -n 10 bash "$(dirname "$0")/run-all-suites.sh" --class drives "$@"
