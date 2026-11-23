#!/usr/bin/env bash
# gate-class: cpu
# gate-watch: src/integrations/voice/** src/commands/voice/** native/voice/** native/whisper/** vendor/whisper-models.lock.json build.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/voice"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
drive_members voice 'scripts/voice/$name' "$here/members.txt" '' run || fail=1
if [ "$fail" -eq 0 ]; then echo "✅ VOICE SUITE GREEN"; else echo "❌ VOICE SUITE RED"; fi
exit "$fail"
