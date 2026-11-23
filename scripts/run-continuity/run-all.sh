#!/usr/bin/env bash
# gate-class: pure
# gate-watch: src/screen/prompts-panel/**
# gate-watch: src/screen/workbench/**
# gate-watch: src/screen/diff/DiffDetailView.tsx src/screen/diff/DiffDialog.tsx src/screen/diff/DiffFileList.tsx src/screen/diff/diff-dialog/** src/screen/diff/diffSources.ts src/screen/diff/reviewLayer.ts
# gate-watch: src/screen/messages/AssistantTextMessage.tsx
# gate-watch: scripts/ui/render-tui.ts src/engine/rows/turn.ts
# gate-watch: src/screen/messages/Message.tsx
set -uo pipefail
. "$(dirname "$0")/../lib/suite-env.sh" || exit 78; suite_env_guard "$0"
. "$(dirname "$0")/../lib/drive-members.sh" || exit 78

cd "$(dirname "$0")/../.." || exit 1
here="scripts/run-continuity"
fail=0
drive_members run-continuity 'scripts/run-continuity/$name' "$here/members.txt" '' run || fail=1
exit $fail
