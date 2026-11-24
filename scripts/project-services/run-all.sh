#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/crew/agent-results/** src/crew/crewmates/crewmateTranscriptReader.ts src/engine/messages/*
# gate-watch: src/engine/run/**
# gate-watch: src/screen/renderer/**
# gate-watch: src/sessions/fabric/entryCodec.ts
# gate-watch: scripts/lib/proofHome.ts
# gate-watch: src/sessions/fabric/ordinal.ts src/tools/**
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/project-services"
fail=0
echo "############################################################"
echo "# project-services — proof harness"
echo "############################################################"
drive_members project-services 'scripts/project-services/$name' "$here/members.txt" || fail=1
echo "############################################################"
if [ "$fail" = "0" ]; then echo "# ✅ ALL project-services PROOFS PASS"; else echo "# ❌ SOME project-services PROOFS FAILED"; fi
echo "############################################################"
exit "$fail"
