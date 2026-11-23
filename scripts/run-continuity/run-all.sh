#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/engine/rows/turn.ts
# gate-watch: src/screen/diff/**
# gate-watch: src/screen/messages/AssistantTextMessage.tsx
# gate-watch: src/screen/messages/Message.tsx
# gate-watch: scripts/ui/render-tui.ts src/screen/prompts-panel/**
# gate-watch: src/screen/workbench/**
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/run-continuity"
fail=0
drive_members run-continuity 'scripts/run-continuity/$name' "$here/members.txt" '' run || fail=1
exit $fail
