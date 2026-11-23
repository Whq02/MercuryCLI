#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/integrations/samples/** src/tools/engines/eval-kernels/** src/tools/eval/** src/screen/samples/**
# gate-watch: scripts/lib/*
# gate-watch: src/engine/connector/daemonConnector.ts
# gate-watch: src/tools/edit/EditTool.ts
# gate-watch: src/tools/read/ReadTool.ts
# gate-watch: src/engine/rows/* src/daemon/runner-wire/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/samples"
fail=0
echo "############################################################"
echo "# samples — proof harness"
echo "############################################################"
drive_members samples 'scripts/samples/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL samples PROOFS PASS"; else echo "# ❌ SOME samples PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
