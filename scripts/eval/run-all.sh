#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/eval/** src/tools/EvalTool/**
# gate-watch: src/services/samples/**
# gate-watch: src/utils/hooks/** src/utils/waitCeiling.ts
# gate-watch: src/utils/permissions/**
# gate-watch: src/services/engine-connector/daemonConnector.ts
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
