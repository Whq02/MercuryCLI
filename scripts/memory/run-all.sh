#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/daemon/runner/*
# gate-watch: src/engine/loop/turn/** src/engine/turn-entry/stopHooks.ts
# gate-watch: src/integrations/samples/**
# gate-watch: src/models/jev/jevClient.ts
# gate-watch: scripts/lib/spawnCapture.ts
# gate-watch: scripts/ui/**
# gate-watch: src/permissions/rules/decision/engine.ts
# gate-watch: src/permissions/rules/permissionDoor.ts src/permissions/rules/permissionMode.ts src/screen/widgets/useFlatList.ts src/sessions/instructions/sourceText.ts
# gate-watch: scripts/streaming/artifactArena.ts
# gate-watch: src/sessions/mneme/**
# gate-watch: native/embed/**
# gate-watch: src/tools/engines/eval-kernels/evalBridge.ts
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/memory"
fail=0
echo "############################################################"
echo "# Memory — proof harness"
echo "############################################################"
drive_members memory 'scripts/memory/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL MEMORY PROOFS PASS"; else echo "# ❌ SOME MEMORY PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
