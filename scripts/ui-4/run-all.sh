#!/usr/bin/env bash
# gate-class: pty
# gate-env: MERCURY_RENDER_CWD
# gate-watch: scripts/ui/**
# gate-watch: src/bootstrap/state* src/components/** src/context/overlayContext*
# gate-watch: src/context/overlayStack* src/daemon/** src/hooks/useLayoutTier* src/ink/**
# gate-watch: src/services/run/** src/state/AppState* src/utils/**
# gate-watch: scripts/lib/*
# gate-watch: src/commands/feedback/issueForms.ts
# gate-watch: src/history.ts src/native-ts/color-diff/index.ts
# gate-watch: src/services/api/usage.ts src/services/anthropicLimits.ts src/services/mockRateLimits.ts
# gate-watch: src/services/providers/providerUsage.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/ui-4"

fail=0
drive_members ui-4 'scripts/ui/$name' "$here/members.txt" '' run || fail=1

if [ "$fail" -eq 0 ]; then echo "✅ UI-4 SUITE GREEN"; else echo "❌ UI-4 SUITE RED"; fi
exit "$fail"
