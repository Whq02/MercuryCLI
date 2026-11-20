#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/services/advisor/** src/types/message.ts src/components/messages/SystemTextMessage.tsx
# gate-watch: src/tools/AskAdvisorTool/** src/cli/headless/turnDriver.ts
# gate-watch: src/services/engine-connector/**
# gate-watch: src/rows/* src/runner/wire/*
# gate-watch: src/cli/headless/*
set -u
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/advisor"
fail=0
export MERCURY_CREDENTIAL_STORE="${MERCURY_CREDENTIAL_STORE:-file}"
drive_members advisor 'scripts/advisor/$name' "$here/members.txt" || fail=1
echo
if [ "$fail" -eq 0 ]; then echo "ADVISOR SUITE GREEN"; else echo "ADVISOR SUITE RED"; fi
exit "$fail"
