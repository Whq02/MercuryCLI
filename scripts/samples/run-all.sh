#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/daemon/runner-wire/* src/engine/connector/daemonConnector.ts src/engine/rows/* src/integrations/samples/**
# gate-watch: scripts/lib/*
# gate-watch: src/screen/samples/**
# gate-watch: src/tools/edit/EditTool.ts
# gate-watch: src/tools/engines/eval-kernels/**
# gate-watch: src/tools/eval/** src/tools/read/ReadTool.ts
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
