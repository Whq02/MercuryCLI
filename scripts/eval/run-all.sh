#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/engine/connector/daemonConnector.ts src/integrations/event-hooks/**
# gate-watch: src/integrations/samples/**
# gate-watch: src/permissions/rules/**
# gate-watch: src/tools/engines/eval-kernels/**
# gate-watch: src/tools/eval/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/eval"
fail=0
echo "############################################################"
echo "# eval kernels — proof harness"
echo "############################################################"
drive_members eval 'scripts/eval/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL EVAL PROOFS PASS"; else echo "# ❌ SOME EVAL PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
