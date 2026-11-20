#!/usr/bin/env bash
# gate-class: pure
# gate-watch: scripts/ui/**
# gate-watch: src/daemon/** src/hooks/useCwdState* src/ink/**
# gate-watch: src/services/anthropicLimits*
# gate-watch: src/hooks/fileSuggestions.ts
# gate-watch: src/services/run/**
# gate-watch: src/substrate/bootNotes*
# gate-watch: src/types/logs* src/utils/**
# gate-watch: scripts/lib/*
# gate-watch: src/hooks/*
# gate-watch: src/keybindings/*
# gate-watch: src/services/concourse/* src/services/engine-connector/*
# gate-watch: src/services/switchboard/bornSession.ts
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/ui-pure-3"

fail=0
drive_members ui-pure-3 'scripts/ui/$name' "$here/members.txt" '' run || fail=1

if [ "$fail" -eq 0 ]; then echo "✅ UI-PURE-3 SUITE GREEN"; else echo "❌ UI-PURE-3 SUITE RED"; fi
exit "$fail"
