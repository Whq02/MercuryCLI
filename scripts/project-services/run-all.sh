#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/ink/** src/services/agentResults/** src/services/changeTransaction/**
# gate-watch: src/services/run/**
# gate-watch: src/tools/**
# gate-watch: src/services/messages/attachmentText*
# gate-watch: scripts/lib/proofHome.ts
# gate-watch: src/fabric/entryCodec.ts src/fabric/ordinal.ts
# gate-watch: src/services/crew/agentTranscriptReader.ts
# gate-watch: src/tools.ts
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
