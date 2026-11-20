#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/services/samples/** src/services/eval/** src/tools/EvalTool/** src/components/samples/**
# gate-watch: scripts/lib/*
# gate-watch: src/services/engine-connector/daemonConnector.ts
# gate-watch: src/tools/FileEditTool/FileEditTool.ts
# gate-watch: src/tools/FileReadTool/FileReadTool.ts
# gate-watch: src/rows/* src/runner/wire/*
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
