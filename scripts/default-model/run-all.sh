#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/commands/model/*
# gate-watch: src/models/facts/*
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/default-model"
fail=0
drive_members default-model 'scripts/default-model/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" -eq 0 ]; then echo "✅ DEFAULT-MODEL SUITE GREEN"; else echo "❌ DEFAULT-MODEL SUITE RED"; fi
exit "$fail"
