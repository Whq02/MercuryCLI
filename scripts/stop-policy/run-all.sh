#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/run/**
# gate-watch: src/query/stopHooks*
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/services/health/healthReport.ts src/utils/hooks/fire.ts src/guards/**
# gate-watch: src/run-core/turn/**
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/stop-policy"
fail=0

echo "############################################################"
echo "# stop-policy — evidence-gated persistence proof harness"
echo "############################################################"
drive_members stop-policy 'scripts/stop-policy/$name' "$here/members.txt" || fail=1
exit $fail
