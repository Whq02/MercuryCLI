#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/components/prompts-panel/**
# gate-watch: src/services/workbench/**
# gate-watch: src/components/diff/**
# gate-watch: src/components/messages/AssistantTextMessage.tsx
# gate-watch: scripts/ui/render-tui.ts src/rows/turn.ts
# gate-watch: src/components/Message.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/run-continuity"
fail=0
drive_members run-continuity 'scripts/run-continuity/$name' "$here/members.txt" '' run || fail=1
exit $fail
