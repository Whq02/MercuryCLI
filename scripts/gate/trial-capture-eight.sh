#!/usr/bin/env bash
set -euo pipefail
: "${MERCURY_CONFIG_DIR:?supply a fresh scratch config home and the proof environment}"
export MERCURY_GATE_PTY_MAX=8 VSHOT_SLOTS=8 MERCURY_GATE_JOBS=8
exec nice -n 10 bash "$(dirname "$0")/../run-all-suites.sh"
